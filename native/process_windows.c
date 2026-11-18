// SPDX-License-Identifier: GPL-2.0-or-later
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include "process.h"

static HANDLE child, input, output, reader;
static line_callback deliver;

static wchar_t *wide(const char *s)
{
	int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, NULL, 0);
	if (!n)
		return NULL;
	wchar_t *out = calloc((size_t)n, sizeof(*out));
	if (out)
		MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, out, n);
	return out;
}

static DWORD WINAPI pump(LPVOID unused)
{
	(void)unused;
	char buffer[256], line[256];
	size_t length = 0;
	DWORD read = 0;
	while (ReadFile(output, buffer, sizeof(buffer), &read, NULL) && read) {
		for (DWORD i = 0; i < read; ++i) {
			if (buffer[i] == '\n') {
				line[length] = '\0';
				deliver(line);
				length = 0;
			} else if (buffer[i] != '\r' && length < sizeof(line) - 1) {
				line[length++] = buffer[i];
			}
		}
	}
	deliver("EXIT");
	return 0;
}

bool start_companion(const char *binary, const char *config, line_callback callback)
{
	HANDLE stdin_read = NULL, stdout_write = NULL;
	SECURITY_ATTRIBUTES sa = {sizeof(sa), NULL, TRUE};
	STARTUPINFOEXW startup = {0};
	PROCESS_INFORMATION pi = {0};
	bool attributes = false;
	size_t attr_size = 0;
	wchar_t *program = wide(binary), *path = wide(config);
	wchar_t *command = NULL;
	bool ok = false;
	if (!program || !path)
		goto done;
	size_t length = wcslen(program) + wcslen(path) + 32;
	command = calloc(length, sizeof(*command));
	if (!command || swprintf(command, length, L"\"%ls\" --config \"%ls\"", program, path) < 0)
		goto done;

	if (!CreatePipe(&stdin_read, &input, &sa, 0) || !CreatePipe(&output, &stdout_write, &sa, 0) ||
	    !SetHandleInformation(input, HANDLE_FLAG_INHERIT, 0) ||
	    !SetHandleInformation(output, HANDLE_FLAG_INHERIT, 0))
		goto done;

	InitializeProcThreadAttributeList(NULL, 1, 0, &attr_size);
	startup.lpAttributeList = malloc(attr_size);
	if (!startup.lpAttributeList || !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attr_size))
		goto done;
	attributes = true;
	HANDLE inherited[] = {stdin_read, stdout_write};
	if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
				       inherited, sizeof(inherited), NULL, NULL))
		goto done;

	startup.StartupInfo.cb = sizeof(startup);
	startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
	startup.StartupInfo.hStdInput = stdin_read;
	startup.StartupInfo.hStdOutput = stdout_write;
	startup.StartupInfo.hStdError = stdout_write;
	if (!CreateProcessW(program, command, NULL, NULL, TRUE,
			    CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, NULL, NULL, &startup.StartupInfo, &pi))
		goto done;

	child = pi.hProcess;
	CloseHandle(pi.hThread);
	deliver = callback;
	reader = CreateThread(NULL, 0, pump, NULL, 0, NULL);
	ok = reader != NULL;

done:
	if (stdin_read) CloseHandle(stdin_read);
	if (stdout_write) CloseHandle(stdout_write);
	if (attributes) DeleteProcThreadAttributeList(startup.lpAttributeList);
	free(startup.lpAttributeList);
	free(command);
	free(program);
	free(path);
	if (!ok) stop_companion();
	return ok;
}

void stop_companion(void)
{
	if (input) {
		CloseHandle(input);
		input = NULL;
	}
	if (child) {
		if (WaitForSingleObject(child, 2500) == WAIT_TIMEOUT) {
			TerminateProcess(child, 1);
			WaitForSingleObject(child, INFINITE);
		}
		CloseHandle(child);
		child = NULL;
	}
	if (reader) {
		WaitForSingleObject(reader, INFINITE);
		CloseHandle(reader);
		reader = NULL;
	}
	if (output) {
		CloseHandle(output);
		output = NULL;
	}
}

bool open_dashboard(const char *url)
{
	wchar_t *u = wide(url);
	if (!u) return false;
	INT_PTR result = (INT_PTR)ShellExecuteW(NULL, L"open", u, NULL, NULL, SW_SHOWNORMAL);
	free(u);
	return result > 32;
}
