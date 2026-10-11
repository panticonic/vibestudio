#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>

#define MAX_DIAGNOSTIC_MEMBERS 64

static void fail_errno(const char *operation) {
  int error = errno;
  fprintf(stderr, "%s failed: %s (errno %d)\n", operation, strerror(error), error);
  exit(2);
}

static pid_t parse_pid(const char *value, const char *name) {
  char *end = NULL;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed <= 0 || parsed > INT32_MAX) {
    fprintf(stderr, "invalid %s\n", name);
    exit(2);
  }
  return (pid_t)parsed;
}

static const char *state_name(uint32_t status) {
  switch (status) {
    case SIDL: return "I";
    case SRUN: return "R";
    case SSLEEP: return "S";
    case SSTOP: return "T";
    case SZOMB: return "Z";
    default: return "?";
  }
}

static void json_string(const char *value) {
  putchar('"');
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor++) {
    switch (*cursor) {
      case '"': fputs("\\\"", stdout); break;
      case '\\': fputs("\\\\", stdout); break;
      case '\b': fputs("\\b", stdout); break;
      case '\f': fputs("\\f", stdout); break;
      case '\n': fputs("\\n", stdout); break;
      case '\r': fputs("\\r", stdout); break;
      case '\t': fputs("\\t", stdout); break;
      default:
        if (*cursor < 0x20) printf("\\u%04x", *cursor);
        else putchar(*cursor);
    }
  }
  putchar('"');
}

static int read_process(pid_t pid, struct proc_bsdinfo *info) {
  memset(info, 0, sizeof(*info));
  errno = 0;
  int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info));
  if (bytes == (int)sizeof(*info)) {
    if (info->pbi_pid != (uint32_t)pid) {
      fprintf(stderr, "proc_pidinfo returned the wrong process for pid %d\n", pid);
      exit(2);
    }
    return 1;
  }
  if (bytes == 0 && (errno == ESRCH || errno == ENOENT)) return 0;
  if (bytes == 0 && errno != 0) fail_errno("proc_pidinfo");
  fprintf(stderr, "proc_pidinfo returned an incomplete process record for pid %d\n", pid);
  exit(2);
}

static pid_t *list_group(pid_t group_id, size_t *pid_count) {
  size_t capacity = 4096;
  pid_t *pids = NULL;
  int byte_count = 0;
  for (;;) {
    if (capacity > SIZE_MAX / sizeof(*pids) || capacity > INT32_MAX / sizeof(*pids)) {
      fputs("process group is too large to enumerate\n", stderr);
      free(pids);
      exit(2);
    }
    pid_t *next = realloc(pids, capacity * sizeof(*pids));
    if (next == NULL) {
      free(pids);
      fputs("cannot allocate process group snapshot\n", stderr);
      exit(2);
    }
    pids = next;
    memset(pids, 0, capacity * sizeof(*pids));
    errno = 0;
    byte_count = proc_listpids(PROC_PGRP_ONLY, (uint32_t)group_id, pids,
                               (int)(capacity * sizeof(*pids)));
    if (byte_count < 0 || (byte_count == 0 && errno != 0)) fail_errno("proc_listpids");
    if ((size_t)byte_count < capacity * sizeof(*pids)) break;
    capacity *= 2;
  }
  if ((size_t)byte_count % sizeof(*pids) != 0) {
    free(pids);
    fputs("proc_listpids returned a malformed PID list\n", stderr);
    exit(2);
  }
  *pid_count = (size_t)byte_count / sizeof(*pids);
  return pids;
}

static int same_birth(const struct proc_bsdinfo *left, const struct proc_bsdinfo *right) {
  return left->pbi_pid == right->pbi_pid &&
         left->pbi_start_tvsec == right->pbi_start_tvsec &&
         left->pbi_start_tvusec == right->pbi_start_tvusec;
}

static const struct proc_bsdinfo *find_process(
    const struct proc_bsdinfo *records, size_t record_count, pid_t pid) {
  for (size_t index = 0; index < record_count; index++) {
    if (records[index].pbi_pid == (uint32_t)pid) return &records[index];
  }
  return NULL;
}

static void confirm_terminal_membership(
    pid_t group_id, pid_t leader_pid, const struct proc_bsdinfo *records,
    size_t record_count, int *has_leader, struct proc_bsdinfo *leader_info) {
  /* A listed live process may fork before its pidinfo is read. Only confirm
   * absence after a second list is contained in already-attested terminal
   * births; changed membership is inconclusive rather than silently absent. */
  size_t second_count = 0;
  pid_t *second_pids = list_group(group_id, &second_count);
  for (size_t index = 0; index < second_count; index++) {
    pid_t pid = second_pids[index];
    if (pid <= 0) continue;
    const struct proc_bsdinfo *previous = find_process(records, record_count, pid);
    if (previous == NULL) {
      free(second_pids);
      fputs("process-group membership changed while confirming terminal state\n", stderr);
      exit(2);
    }
    struct proc_bsdinfo current;
    if (!read_process(pid, &current)) continue;
    if (current.pbi_pgid != (uint32_t)group_id) continue;
    if (!same_birth(previous, &current) || current.pbi_status != SZOMB) {
      free(second_pids);
      fputs("process-group member changed while confirming terminal state\n", stderr);
      exit(2);
    }
  }
  free(second_pids);

  *has_leader = read_process(leader_pid, leader_info);
  if (*has_leader && leader_info->pbi_pgid == (uint32_t)group_id &&
      leader_info->pbi_status != SZOMB) {
    fputs("active leader was absent from terminal process-group snapshot\n", stderr);
    exit(2);
  }
}

static void print_process(const struct proc_bsdinfo *info) {
  char start[48];
  snprintf(start, sizeof(start), "%" PRIu64 ".%06" PRIu64,
           (uint64_t)info->pbi_start_tvsec, (uint64_t)info->pbi_start_tvusec);
  char command[MAXCOMLEN + 1];
  memcpy(command, info->pbi_comm, MAXCOMLEN);
  command[MAXCOMLEN] = '\0';
  printf("{\"pid\":%u,\"ppid\":%u,\"pgid\":%u,\"uid\":%u,\"state\":",
         info->pbi_pid, info->pbi_ppid, info->pbi_pgid, info->pbi_uid);
  json_string(state_name(info->pbi_status));
  fputs(",\"startCoordinate\":", stdout);
  json_string(start);
  fputs(",\"command\":", stdout);
  json_string(command);
  putchar('}');
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    puts("1");
    return 0;
  }
  if (argc != 3) {
    fputs("usage: owned-process-group-observer <process-group-id> <leader-pid>\n", stderr);
    return 2;
  }
  pid_t group_id = parse_pid(argv[1], "process group id");
  pid_t leader_pid = parse_pid(argv[2], "leader pid");

  size_t pid_count = 0;
  pid_t *pids = list_group(group_id, &pid_count);
  struct proc_bsdinfo *records = calloc(pid_count == 0 ? 1 : pid_count, sizeof(*records));
  if (records == NULL) {
    free(pids);
    fputs("cannot allocate process group records\n", stderr);
    return 2;
  }
  struct proc_bsdinfo leader_info;
  int has_leader = 0;
  size_t active_count = 0;
  size_t record_count = 0;
  size_t retained_count = 0;
  int truncated = 0;
  struct proc_bsdinfo retained[MAX_DIAGNOSTIC_MEMBERS];

  for (size_t index = 0; index < pid_count; index++) {
    pid_t pid = pids[index];
    if (pid <= 0) continue;
    struct proc_bsdinfo info;
    if (!read_process(pid, &info)) continue;
    if (info.pbi_pgid != (uint32_t)group_id) continue;
    records[record_count++] = info;
    if (pid == leader_pid) {
      leader_info = info;
      has_leader = 1;
    }
    if (info.pbi_status != SZOMB) active_count++;
    if (retained_count == MAX_DIAGNOSTIC_MEMBERS) {
      truncated = 1;
      continue;
    }
    retained[retained_count++] = info;
  }
  free(pids);
  if (active_count == 0) {
    confirm_terminal_membership(
        group_id, leader_pid, records, record_count, &has_leader, &leader_info);
  } else {
    has_leader = read_process(leader_pid, &leader_info);
  }
  free(records);

  printf("{\"version\":1,\"processGroupId\":%d,\"leader\":", group_id);
  if (has_leader) print_process(&leader_info);
  else fputs("null", stdout);
  printf(",\"activeMemberCount\":%zu,\"truncated\":%s,\"members\":[",
         active_count, truncated ? "true" : "false");
  for (size_t index = 0; index < retained_count; index++) {
    if (index != 0) putchar(',');
    print_process(&retained[index]);
  }
  fputs("]}\n", stdout);
  if (fflush(stdout) != 0) fail_errno("write process group snapshot");
  return 0;
}
