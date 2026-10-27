/* CI-only prototype. This does not establish a hostile same-user boundary. */
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int same(struct stat a, struct stat b) { return a.st_dev == b.st_dev && a.st_ino == b.st_ino; }
int main(void) {
  char name[] = "/tmp/cez-stage-probe-XXXXXX";
  if (!mkdtemp(name)) return 1;
  int p = open(name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (p < 0 || mkdirat(p, "stage", 0700) || mkdirat(p, "root", 0000)) return 1;
  int stage = openat(p, "stage", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat owned, moved, outside;
  if (stage < 0 || fstatat(p, "root", &owned, AT_SYMLINK_NOFOLLOW)) return 1;
  /* A durable intent exists before the exclusive claim. */
  int intent = openat(p, "intent", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (intent < 0 || write(intent, "prepared", 8) != 8 || fsync(intent)) return 1;
  close(intent);
  if (renameatx_np(p, "root", stage, "owned", RENAME_EXCL)) { perror("claim"); return 1; }
  /* Resume after interruption: identify the staged inode before changing it. */
  if (fstatat(stage, "owned", &moved, AT_SYMLINK_NOFOLLOW) || !same(owned, moved)) return 1;
  if (fchmodat(stage, "owned", 0700, AT_SYMLINK_NOFOLLOW)) return 1;
  int root = openat(stage, "owned", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (root < 0 || fstat(root, &moved) || !same(owned, moved)) return 1;
  if (mkdirat(p, "target", 0700) || symlinkat("../../target", root, "link")) return 1;
  if (fchmodat(root, "link", 0000, AT_SYMLINK_NOFOLLOW)) return 1;
  if (fstatat(p, "target", &outside, AT_SYMLINK_NOFOLLOW) || (outside.st_mode & 0777) != 0700) return 1;
  /* A competing root prevents restore; never overwrite it. */
  if (mkdirat(p, "root", 0700)) return 1;
  errno = 0; int conflict = renameatx_np(stage, "owned", p, "root", RENAME_EXCL);
  printf("restore_conflict=%d errno=%d\n", conflict, errno);
  if (conflict == 0 || errno != EEXIST) return 1;
  unlinkat(p, "root", AT_REMOVEDIR);
  if (renameatx_np(stage, "owned", p, "root", RENAME_EXCL)) return 1;
  if (fstatat(p, "root", &moved, AT_SYMLINK_NOFOLLOW) || !same(owned, moved)) return 1;
  printf("resumed_restore_matches=1\n");
  close(root);
  if (unlinkat(p, "root/link", 0) || renameat(p, "root", p, "original")) return 1;
  if (unlinkat(p, "target", AT_REMOVEDIR)) return 1;
  /* Simulate a replacement before claim; identity mismatch stops before chmod. */
  if (mkdirat(p, "root", 0000)) return 1;
  if (renameatx_np(p, "root", stage, "owned", RENAME_EXCL)) return 1;
  if (fstatat(stage, "owned", &moved, AT_SYMLINK_NOFOLLOW)) return 1;
  printf("replacement_matches=%d mode=%o\n", same(owned, moved), moved.st_mode & 0777);
  if (same(owned, moved) || (moved.st_mode & 0777) != 0) return 1;
  /* Restore an unowned entry only into a vacant original name. */
  if (renameatx_np(stage, "owned", p, "root", RENAME_EXCL)) return 1;
  unlinkat(p, "root", AT_REMOVEDIR); unlinkat(p, "original", AT_REMOVEDIR); unlinkat(p, "intent", 0);
  close(stage); unlinkat(p, "stage", AT_REMOVEDIR); close(p); rmdir(name);
  return 0;
}
