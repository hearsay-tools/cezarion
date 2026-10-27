/* Diagnostic only: run on a disposable directory on a native macOS runner. */
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
  char path[] = "/tmp/cez-parent-probe-XXXXXX";
  if (!mkdtemp(path)) { perror("mkdtemp"); return 1; }
  int parent = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (parent < 0 || mkdirat(parent, "child", 0000)) { perror("setup"); return 1; }
  struct stat before, after;
  if (fstatat(parent, "child", &before, AT_SYMLINK_NOFOLLOW)) { perror("stat"); return 1; }
  errno = 0;
  int result = fchmodat(parent, "child", 0700, AT_SYMLINK_NOFOLLOW);
  printf("directory_fchmodat=%d errno=%d\n", result, errno);
  if (result || fstatat(parent, "child", &after, AT_SYMLINK_NOFOLLOW) || before.st_ino != after.st_ino) return 1;
  int child = openat(parent, "child", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (child < 0 || fstat(child, &after) || before.st_ino != after.st_ino) return 1;
  close(child);
  if (mkdirat(parent, "outside", 0700) || symlinkat("outside", parent, "link")) return 1;
  errno = 0;
  result = fchmodat(parent, "link", 0000, AT_SYMLINK_NOFOLLOW);
  printf("symlink_fchmodat=%d errno=%d\n", result, errno);
  if (fstatat(parent, "outside", &after, AT_SYMLINK_NOFOLLOW) || (after.st_mode & 0777) != 0700) return 1;
  unlinkat(parent, "link", 0); unlinkat(parent, "outside", AT_REMOVEDIR);
  unlinkat(parent, "child", AT_REMOVEDIR); close(parent); rmdir(path);
  return 0;
}
