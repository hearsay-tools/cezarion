declare module '*e2e-catalogs.mjs' {
  export const PROJECT_CATALOGS: string[];
  export function replaceProjectCatalogs(root: string): void;
}
