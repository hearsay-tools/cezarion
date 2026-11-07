import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandResult, Runner } from '../types.ts';

/**
 * A fake Ubuntu host behind the `Runner` seam: a sandboxed filesystem for `/etc` paths, systemd
 * units and an nginx that serves the configuration of its last reload. No command reaches the
 * real system. The small shell covers the commands the installer and server-migrate emit.
 */

type Scope = 'user' | 'system';
interface Unit { enabled: boolean; active: boolean; starts: number }
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const fail = (code = 1, stderr = ''): CommandResult => ({ code, stdout: '', stderr });
export const fakeHash = (password: string) => `$apr1$fake$${Buffer.from(password).toString('hex')}`;

function tokenize(script: string): string[] {
  const tokens: string[] = [];
  let word: string | undefined;
  const push = () => { if (word !== undefined) tokens.push(word); word = undefined; };
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (c === "'") {
      const end = script.indexOf("'", i + 1);
      word = (word ?? '') + script.slice(i + 1, end);
      i = end;
    } else if (/\s/.test(c)) push();
    else if ('&|;{}!>'.includes(c) && word === undefined || '&|;'.includes(c)) {
      push();
      const two = script.slice(i, i + 2);
      if (['&&', '||', '>>'].includes(two)) { tokens.push(two); i++; } else tokens.push(c);
    } else word = (word ?? '') + c;
  }
  push();
  return tokens;
}

export class FakeUbuntuHost implements Runner {
  readonly units = new Map<string, Unit>();
  readonly commands: string[] = [];
  /** Units whose process starts but never answers. */
  readonly unhealthy = new Set<string>();
  /** Units whose `systemctl disable` fails and leaves them as they are. */
  readonly failDisable = new Set<string>();
  nginxTestFailures = 0;
  tlsBroken = false;
  hang?: (command: string) => boolean;
  onUpstreamProbe?: () => void;
  private loaded: string[] = [];

  constructor(readonly root: string, readonly userUnitDir: string) { mkdirSync(userUnitDir, { recursive: true }); }

  path(path: string): string { return path.startsWith(this.root) ? path : join(this.root, 'sys', path); }
  exists(path: string): boolean { try { lstatSync(this.path(path)); return true; } catch { return false; } }
  read(path: string): string { return readFileSync(this.path(path), 'utf8'); }
  write(path: string, content: string): void { mkdirSync(dirname(this.path(path)), { recursive: true }); writeFileSync(this.path(path), content); }
  link(target: string, path: string): void { mkdirSync(dirname(this.path(path)), { recursive: true }); symlinkSync(this.path(target), this.path(path)); }
  unit(scope: Scope, name: string): Unit {
    const key = `${scope}:${name}`;
    if (!this.units.has(key)) this.units.set(key, { enabled: false, active: false, starts: 0 });
    return this.units.get(key)!;
  }
  unitFile(scope: Scope, name: string): string { return scope === 'user' ? join(this.userUnitDir, name) : this.path(`/etc/systemd/system/${name}`); }
  enabledSites(): string[] {
    const dir = this.path('/etc/nginx/sites-enabled');
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }
  reloadNginx(): void {
    const dir = this.path('/etc/nginx/sites-enabled');
    this.loaded = this.enabledSites().map((name) => readFileSync(readlinkSync(join(dir, name)), 'utf8'));
  }

  async capture(program: string, args: string[], opts?: { input?: string }): Promise<CommandResult> {
    return this.exec([program, ...args], opts?.input ?? '');
  }

  async interactive(program: string, args: string[], opts?: { input?: string }): Promise<number> {
    const command = program === 'sudo' && args[0] === 'bash' ? args[2]! : [program, ...args].join(' ');
    this.commands.push(command);
    if (this.hang?.(command)) return new Promise<number>(() => {});
    if (program === 'sudo' && args[0] === 'bash') return this.shell(command, opts?.input ?? '').code;
    return (await this.capture(program, args, opts)).code;
  }

  shell(script: string, stdin = ''): CommandResult {
    const tokens = tokenize(script);
    let at = 0;
    const list = (): CommandResult => {
      let result = andOr();
      while (tokens[at] === ';') { at++; if (at < tokens.length && tokens[at] !== '}') result = andOr(); }
      return result;
    };
    const andOr = (): CommandResult => {
      let result = pipeline();
      while (tokens[at] === '&&' || tokens[at] === '||') {
        const op = tokens[at++];
        const run = op === '&&' ? result.code === 0 : result.code !== 0;
        if (run) result = pipeline();
        else skip();
      }
      return result;
    };
    const skip = () => { let depth = 0; while (at < tokens.length && (depth || !['&&', '||', ';', '}'].includes(tokens[at]!))) { if (tokens[at] === '{') depth++; if (tokens[at] === '}') depth--; at++; } };
    const pipeline = (): CommandResult => {
      const negate = tokens[at] === '!' && ++at > 0;
      let result = command(stdin);
      while (tokens[at] === '|') { at++; result = command(result.stdout); }
      return negate ? { ...result, code: result.code === 0 ? 1 : 0 } : result;
    };
    const command = (input: string): CommandResult => {
      if (tokens[at] === '{') { at++; const result = list(); at++; return result; }
      const words: string[] = [];
      let redirect: [string, string] | undefined;
      while (at < tokens.length && !['&&', '||', ';', '|', '}'].includes(tokens[at]!)) {
        const token = tokens[at++]!;
        if (token === '>' || token === '>>') redirect = [token, tokens[at++]!];
        else if (!token.startsWith('2>')) words.push(token);
      }
      const result = this.exec(words, input);
      if (redirect && result.code === 0) {
        if (redirect[0] === '>') this.write(redirect[1], result.stdout);
        else appendFileSync(this.path(redirect[1]), result.stdout);
        return ok();
      }
      return result;
    };
    return list();
  }

  private exec([program, ...args]: string[], stdin: string): CommandResult {
    const run = this.programs[program!];
    return run ? run(args, stdin) : fail(127, `fake host: unknown command ${program}`);
  }

  private readonly programs: Record<string, (args: string[], stdin: string) => CommandResult> = {
    true: () => ok(), chown: () => ok(), chmod: () => ok(), sleep: () => ok(), false: () => fail(),
    sh: (args, stdin) => this.shell(args[1]!, stdin),
    sudo: (args) => args[0] === '-n' && args[1] === 'true' ? ok() : fail(),
    printf: (args) => ok(args[1]),
    base64: (_args, stdin) => ok(Buffer.from(stdin, 'base64').toString('utf8')),
    cat: (args, stdin) => {
      if (args.length === 0) return ok(stdin);
      return this.exists(args[0]!) ? ok(this.read(args[0]!)) : fail();
    },
    install: (args) => { mkdirSync(this.path(args.at(-1)!), { recursive: true }); return ok(); },
    cp: ([, from, to]) => {
      if (!this.exists(from!)) return fail();
      copyFileSync(this.path(from!), this.path(to!));
      return ok();
    },
    mv: ([from, to]) => {
      if (!this.exists(from!)) return fail();
      renameSync(this.path(from!), this.path(to!));
      return ok();
    },
    rm: (args) => {
      for (const path of args.filter((a) => !a.startsWith('-'))) rmSync(this.path(path), { force: true });
      return ok();
    },
    rmdir: ([path]) => {
      try { rmdirSync(this.path(path!)); return ok(); } catch { return fail(); }
    },
    ln: (args) => {
      const [target, path] = args.filter((a) => !a.startsWith('-')) as [string, string];
      if (this.exists(path)) {
        if (!args[0]!.includes('f')) return fail();
        rmSync(this.path(path));
      }
      this.link(target, path);
      return ok();
    },
    test: ([flag, path]) => {
      if (!this.exists(path!)) return fail();
      if (flag === '-L') return lstatSync(this.path(path!)).isSymbolicLink() ? ok() : fail();
      return flag !== '-f' || existsSync(this.path(path!)) ? ok() : fail();
    },
    grep: ([flags, pattern, ...files]) => {
      const match = (text: string) => flags!.includes('F') ? text.includes(pattern!) : new RegExp(pattern!, 'm').test(text);
      return files.some((file) => existsSync(this.path(file)) && match(this.read(file))) ? ok() : fail();
    },
    sed: ([flag, script, file]) => {
      const expression = /^\/(.*)\/d$/.exec(script!);
      if (flag !== '-i' || !expression) return fail(2, 'fake sed supports only -i /re/d');
      const re = new RegExp(expression[1]!);
      this.write(file!, this.read(file!).split('\n').filter((line) => !re.test(line)).join('\n'));
      return ok();
    },
    nginx: (args) => this.nginx(args),
    openssl: (_args, stdin) => ok(`${fakeHash(stdin.trimEnd())}\n`),
    systemctl: (args) => this.systemctl(args),
    curl: (args, stdin) => ok(this.curl(args, stdin)),
  };

  private nginx(args: string[]): CommandResult {
    if (args[0] === '-v') return { code: 0, stdout: '', stderr: 'nginx version: nginx/1.24.0' };
    if (this.nginxTestFailures > 0) { this.nginxTestFailures--; return fail(1, 'nginx: configuration test failed'); }
    const dir = this.path('/etc/nginx/sites-enabled');
    return this.enabledSites().every((name) => existsSync(join(dir, name))) ? ok() : fail();
  }

  private systemctl(args: string[]): CommandResult {
    const scope: Scope = args[0] === '--user' ? 'user' : 'system';
    const options = args.filter((a) => a.startsWith('--'));
    const [verb, name] = args.filter((a) => !a.startsWith('--')) as [string, string | undefined];
    if (verb === 'daemon-reload') return ok();
    if (verb === 'reload' && name === 'nginx') { this.reloadNginx(); return ok(); }
    const run = name ? this.verbs[verb] : undefined;
    if (!run) return fail();
    if (verb === 'disable' && this.failDisable.has(name!)) return fail(1, 'fake: disable failed');
    return run(this.unit(scope, name!), existsSync(this.unitFile(scope, name!)), options.includes('--now'));
  }

  private readonly verbs: Record<string, (unit: Unit, present: boolean, now: boolean) => CommandResult> = {
    enable: (unit, present) => { if (!present) return fail(); unit.enabled = true; return ok(); },
    disable: (unit, present, now) => {
      if (!present) return fail();
      unit.enabled = false;
      if (now) unit.active = false;
      return ok();
    },
    start: (unit, present) => this.start(unit, present),
    restart: (unit, present) => this.start(unit, present),
    stop: (unit) => { unit.active = false; return ok(); },
    'is-active': (unit) => unit.active ? ok('active') : fail(3),
    'is-enabled': (unit, present) => unit.enabled && present ? ok('enabled') : fail(),
    show: (unit) => ok(`ActiveState=${unit.active ? 'active' : 'inactive'}\nExecMainStartTimestampMonotonic=${unit.starts * 100}\n` +
      'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/cezar/dist/index.js }\n'),
  };

  private start(unit: Unit, present: boolean): CommandResult {
    if (!present) return fail();
    unit.active = true;
    unit.starts++;
    return ok();
  }

  /** Units answer on the `--port` of their unit file while active and healthy. */
  upstream(port: number): boolean {
    for (const [key, unit] of this.units) {
      const [scope, name] = key.split(':') as [Scope, string];
      if (!unit.active || this.unhealthy.has(name) || !existsSync(this.unitFile(scope, name))) continue;
      if (new RegExp(`--port ${port}\\b`).test(readFileSync(this.unitFile(scope, name), 'utf8'))) return true;
    }
    return false;
  }

  /** nginx answers a name only on the address and port one of its sites listens on. */
  private curl(args: string[], stdin: string): string {
    const url = new URL(args.at(-1)!);
    const at = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1]! : undefined; };
    const resolve = at('--resolve')?.match(/^([^:]+):(\d+):(.+)$/);
    if (url.port && !resolve) { this.onUpstreamProbe?.(); return this.upstream(Number(url.port)) ? '200' : '000'; }
    if (resolve ? resolve[1] !== url.hostname : url.hostname !== '127.0.0.1') return '000'; // The fake has no DNS.
    return this.nginxAnswer(url, resolve?.[3], at('-H')?.replace(/^Host: /, '') ?? (resolve ? url.hostname : undefined), stdin);
  }

  private nginxAnswer(url: URL, resolved: string | undefined, host: string | undefined, stdin: string): string {
    const https = url.protocol === 'https:';
    const port = Number(url.port || (https ? 443 : 80));
    const address = resolved ?? '127.0.0.1';
    const listening = this.loaded.filter((text) => listens(text, address, port, https));
    if (!listening.length || (https && this.tlsBroken)) return '000';
    const site = listening.find((text) => text.includes(`server_name ${host ?? '_'};`));
    if (!site) return '404';
    if (!https && /return 301 https:/.test(site)) return '301';
    return this.authorized(site, stdin);
  }

  private authorized(site: string, stdin: string): string {
    const file = /auth_basic_user_file (\S+);/.exec(site)?.[1];
    const login = /user = "([^:]*):(.*)"/.exec(stdin);
    const lines = file && this.exists(file) ? this.read(file).split('\n') : [];
    if (!login || !lines.includes(`${login[1]}:${fakeHash(login[2]!)}`)) return '401';
    const port = Number(/proxy_pass http:\/\/127\.0\.0\.1:(\d+);/.exec(site)?.[1]);
    return this.upstream(port) ? '200' : '502';
  }
}

function listens(site: string, address: string, port: number, ssl: boolean): boolean {
  return [...site.matchAll(/^\s*listen\s+([^;\s]+)([^;]*);/gm)].some(([, where, rest]) => {
    const match = /^(?:(.+):)?(\d+)$/.exec(where!);
    if (!match || Number(match[2]) !== port) return false;
    const bound = match[1];
    return (!bound || bound === '[::]' || bound === address) && (!ssl || /\bssl\b/.test(rest!));
  });
}
