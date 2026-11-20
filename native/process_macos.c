// SPDX-License-Identifier: GPL-2.0-or-later
#include <crt_externs.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include "process.h"

static int input = -1, output = -1;
static pid_t child;
static pthread_t reader;
static bool reader_started;
static line_callback deliver;

static void *pump(void *unused)
{
	(void)unused;
	FILE *stream = fdopen(output, "r");
	if (stream) {
		char line[256];
		while (fgets(line, sizeof(line), stream)) {
			line[strcspn(line, "\r\n")] = '\0';
			deliver(line);
		}
		fclose(stream);
	} else {
		close(output);
	}
	deliver("EXIT");
	return NULL;
}

static bool cloexec_pipe(int fds[2])
{
	if (pipe(fds))
		return false;
	if (fcntl(fds[0], F_SETFD, FD_CLOEXEC) || fcntl(fds[1], F_SETFD, FD_CLOEXEC)) {
		close(fds[0]); close(fds[1]);
		fds[0] = fds[1] = -1;
		return false;
	}
	return true;
}

bool start_companion(const char *binary, const char *config, line_callback callback)
{
	int in[2] = {-1, -1}, out[2] = {-1, -1};
	bool ok = false;
	if (!cloexec_pipe(in) || !cloexec_pipe(out))
		goto done;
	posix_spawn_file_actions_t actions;
	if (posix_spawn_file_actions_init(&actions))
		goto done;
	char *const args[] = {(char *)binary, "--config", (char *)config, NULL};
	int result = posix_spawn_file_actions_adddup2(&actions, in[0], STDIN_FILENO) ||
		posix_spawn_file_actions_adddup2(&actions, out[1], STDOUT_FILENO) ||
		posix_spawn_file_actions_adddup2(&actions, out[1], STDERR_FILENO);
	pid_t spawned;
	if (!result && !posix_spawn(&spawned, binary, &actions, NULL, args, *_NSGetEnviron())) {
		child = spawned;
		input = in[1]; in[1] = -1;
		output = out[0]; out[0] = -1;
		deliver = callback;
		ok = reader_started = pthread_create(&reader, NULL, pump, NULL) == 0;
	}
	posix_spawn_file_actions_destroy(&actions);

done:
	for (int i = 0; i < 2; ++i) {
		if (in[i] >= 0) close(in[i]);
		if (out[i] >= 0) close(out[i]);
	}
	if (!ok) stop_companion();
	return ok;
}

void stop_companion(void)
{
	if (input >= 0) {
		close(input);
		input = -1;
	}
	if (child) {
		kill(child, SIGTERM);
		while (waitpid(child, NULL, 0) == -1 && errno == EINTR) {}
		child = 0;
	}
	if (reader_started) {
		pthread_join(reader, NULL);
		reader_started = false;
	} else if (output >= 0) {
		close(output);
	}
	output = -1;
}

bool open_dashboard(const char *url)
{
	char *const args[] = {"open", (char *)url, NULL};
	pid_t pid;
	if (posix_spawn(&pid, "/usr/bin/open", NULL, NULL, args, *_NSGetEnviron()))
		return false;
	int status;
	while (waitpid(pid, &status, 0) == -1) {
		if (errno != EINTR) return false;
	}
	return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

