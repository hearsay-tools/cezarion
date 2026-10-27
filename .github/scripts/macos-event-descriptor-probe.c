#include <sys/types.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

/* Native-CI feasibility probe only. Uses only its own mkdtemp directory. */
int main(void) {
  char base[PATH_MAX], root[PATH_MAX], saved[PATH_MAX];
  struct stat original, opened, after, replacement;
  int fd = -1, failed = 1;
  if (!realpath("/tmp", base)) { perror("realpath"); return 1; }
  if (snprintf(root, sizeof root, "%s/cez-event-probe-XXXXXX", base) >= sizeof root || !mkdtemp(root)) return 1;
  if (snprintf(saved, sizeof saved, "%s.saved", root) >= sizeof saved) goto cleanup;
  if (lstat(root, &original) || chmod(root, 0)) goto cleanup;
  errno = 0;
  fd = open(root, O_EVTONLY | O_DIRECTORY | O_NOFOLLOW_ANY);
  printf("before_policy_fd=%d errno=%d\n", fd, errno);
  if (fd >= 0) { close(fd); fd = -1; }
  errno = 0;
  int policy = setiopolicy_np(IOPOL_TYPE_VFS_DISALLOW_RW_FOR_O_EVTONLY,
                            IOPOL_SCOPE_PROCESS,
                            IOPOL_VFS_DISALLOW_RW_FOR_O_EVTONLY_ON);
  printf("set_policy=%d errno=%d\n", policy, errno);
  if (policy != 0) goto cleanup;
  errno = 0;
  fd = open(root, O_EVTONLY | O_DIRECTORY | O_NOFOLLOW_ANY);
  printf("after_policy_fd=%d errno=%d\n", fd, errno);
  if (fd < 0 || fstat(fd, &opened) || !S_ISDIR(opened.st_mode) ||
      opened.st_dev != original.st_dev || opened.st_ino != original.st_ino) goto cleanup;
  /* Swap the pathname after open. fchmod must affect only the pinned inode. */
  if (rename(root, saved) || mkdir(root, 0)) goto cleanup;
  errno = 0;
  int changed = fchmod(fd, 0700);
  printf("descriptor_chmod=%d errno=%d\n", changed, errno);
  if (changed || lstat(saved, &after) || lstat(root, &replacement) ||
      after.st_ino != original.st_ino || (after.st_mode & 0777) != 0700 ||
      replacement.st_ino == original.st_ino || (replacement.st_mode & 0777) != 0) goto cleanup;
  printf("pinned_inode_repaired=1 replacement_untouched=1\n");
  if (rmdir(root) || symlink(saved, root)) goto cleanup;
  errno = 0;
  int linkfd = open(root, O_EVTONLY | O_DIRECTORY | O_NOFOLLOW_ANY);
  int linkerr = errno;
  printf("symlink_fd=%d errno=%d\n", linkfd, linkerr);
  if (linkfd >= 0) { close(linkfd); goto cleanup; }
  if (linkerr != ELOOP) goto cleanup;
  failed = 0;
cleanup:
  if (failed) perror("probe failed");
  if (fd >= 0) close(fd);
  struct stat remaining;
  if (lstat(root, &remaining) == 0 && S_ISLNK(remaining.st_mode)) unlink(root);
  else { chmod(root, 0700); rmdir(root); }
  chmod(saved, 0700); rmdir(saved);
  return failed;
}
