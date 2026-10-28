#include <fcntl.h>
#include <stdio.h>
#include <signal.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
static void *mapped;
static void release_mapping(int sig) { (void)sig; if (mapped) { munmap(mapped, 4096); mapped = NULL; } }
int main(int argc, char **argv) {
  if (argc != 3 && argc != 4) return 2;
  if (argc == 4) {
    pid_t child = fork();
    if (child < 0) return 6;
    if (child > 0) { while (access(argv[3], F_OK) != 0) usleep(1000); return 0; }
    if (setsid() < 0) return 7;
  }
  int fd = open(argv[1], O_RDONLY);
  if (fd < 0) return 3;
  void *p = mmap(NULL, 4096, PROT_READ, MAP_SHARED, fd, 0);
  if (p == MAP_FAILED || close(fd)) return 4;
  mapped = p; signal(SIGUSR1, release_mapping);
  FILE *f = fopen(argv[2], "w");
  if (!f) return 5;
  fprintf(f, "%ld\n", (long)getpid()); fclose(f);
  for (;;) pause();
}
