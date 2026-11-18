// SPDX-License-Identifier: GPL-2.0-or-later
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <msiquery.h>
#include <tlhelp32.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

static UINT stop_install(MSIHANDLE install, const wchar_t *message)
{
	MSIHANDLE record = MsiCreateRecord(1);
	if (record) {
		MsiRecordSetStringW(record, 0, L"[1]");
		MsiRecordSetStringW(record, 1, message);
		MsiProcessMessage(install, INSTALLMESSAGE_ERROR | MB_OK | MB_ICONERROR, record);
		MsiCloseHandle(record);
	}
	return ERROR_INSTALL_FAILURE;
}

static int running_obs(void)
{
	HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
	if (snapshot == INVALID_HANDLE_VALUE)
		return -1;
	PROCESSENTRY32W entry = {0};
	entry.dwSize = sizeof(entry);
	if (!Process32FirstW(snapshot, &entry)) {
		CloseHandle(snapshot);
		return -1;
	}
	int found = 0;
	do {
		if (!_wcsicmp(entry.szExeFile, L"obs64.exe") || !_wcsicmp(entry.szExeFile, L"obs32.exe") ||
		    !_wcsicmp(entry.szExeFile, L"obs.exe")) {
			found = 1;
			break;
		}
	} while (Process32NextW(snapshot, &entry));
	CloseHandle(snapshot);
	return found;
}

static bool path_join(wchar_t *path, size_t count, const wchar_t *dir, const wchar_t *relative)
{
	int length = swprintf(path, count, L"%ls\\%ls", dir, relative);
	return length > 0 && (size_t)length < count;
}

static bool exists(const wchar_t *dir, const wchar_t *relative)
{
	wchar_t path[4096];
	if (!path_join(path, 4096, dir, relative))
		return false;
	DWORD attr = GetFileAttributesW(path);
	return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

static bool read_exact(HANDLE f, void *data, DWORD size)
{
	DWORD read = 0;
	return ReadFile(f, data, size, &read, NULL) && read == size;
}

static bool obs_version_ok(const wchar_t *path)
{
	HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
	if (file == INVALID_HANDLE_VALUE)
		return false;
	IMAGE_DOS_HEADER dos;
	DWORD signature;
	IMAGE_FILE_HEADER pe;
	bool x64 = read_exact(file, &dos, sizeof(dos)) && dos.e_magic == IMAGE_DOS_SIGNATURE &&
		dos.e_lfanew >= (LONG)sizeof(dos) && SetFilePointer(file, dos.e_lfanew, NULL, FILE_BEGIN) != INVALID_SET_FILE_POINTER &&
		read_exact(file, &signature, sizeof(signature)) && signature == IMAGE_NT_SIGNATURE &&
		read_exact(file, &pe, sizeof(pe)) && pe.Machine == IMAGE_FILE_MACHINE_AMD64;
	CloseHandle(file);
	if (!x64)
		return false;
	DWORD ignored;
	DWORD size = GetFileVersionInfoSizeW(path, &ignored);
	void *data = size ? malloc(size) : NULL;
	VS_FIXEDFILEINFO *version = NULL;
	UINT length = 0;
	bool valid = false;
	if (data && GetFileVersionInfoW(path, 0, size, data)) {
		if (VerQueryValueW(data, L"\\", (void **)&version, &length) && length >= sizeof(*version)) {
			valid = HIWORD(version->dwProductVersionMS) == 33 &&
				(LOWORD(version->dwProductVersionMS) > 0 || HIWORD(version->dwProductVersionLS) >= 1);
		}
		if (!valid) {
			WORD *translation = NULL;
			if (VerQueryValueW(data, L"\\VarFileInfo\\Translation", (void **)&translation, &length) &&
			    length >= 2 * sizeof(WORD)) {
				wchar_t query[96];
				swprintf(query, 96, L"\\StringFileInfo\\%04x%04x\\ProductVersion",
					 (unsigned)translation[0], (unsigned)translation[1]);
				wchar_t *product_version = NULL;
				unsigned major = 0, minor = 0, patch = 0;
				valid = VerQueryValueW(data, query, (void **)&product_version, &length) &&
					swscanf(product_version, L"%u.%u.%u", &major, &minor, &patch) == 3 &&
					major == 33 && (minor > 0 || patch >= 1);
			}
		}
	}
	free(data);
	return valid;
}

static void append_missing(wchar_t *message, const wchar_t *item)
{
	wcscat(message, L"\r\n - ");
	wcscat(message, item);
}

/* MSI version properties can report compatibility values on newer Windows. */
static bool windows_supported(void)
{
	DWORD major = 0;
	DWORD size = sizeof(major);
	LSTATUS result = RegGetValueW(HKEY_LOCAL_MACHINE,
		L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", L"CurrentMajorVersionNumber",
		RRF_RT_REG_DWORD, NULL, &major, &size);
	return result == ERROR_SUCCESS && major >= 10;
}

__declspec(dllexport) UINT __stdcall CheckOBS(MSIHANDLE install)
{
	int running = running_obs();
	if (running == 1)
		return stop_install(install, L"OBS Studio is running. Close OBS Studio and run this installer again.");
	if (running < 0)
		return stop_install(install, L"Setup could not verify whether OBS Studio is running.");
	wchar_t removal[32] = L"";
	DWORD chars = 32;
	MsiGetPropertyW(install, L"REMOVE", removal, &chars);
	if (!_wcsicmp(removal, L"ALL"))
		return ERROR_SUCCESS;

	if (!windows_supported())
		return stop_install(install, L"LAN Lens requires Windows 10 or later. Setup could not verify a supported Windows version.");

	wchar_t root[4096];
	chars = 4096;
	if (MsiGetPropertyW(install, L"OBSROOT", root, &chars) != ERROR_SUCCESS || !chars)
		return stop_install(install, L"OBS Studio was not found. Install the full 64-bit OBS Studio 33.x release (33.0.1 or later).");

	wchar_t missing[2048] = L"Setup found missing or incompatible prerequisites:";
	const size_t base_length = wcslen(missing);
	wchar_t path[4096], browser[4096], bin[4096], system[MAX_PATH];
	if (!path_join(path, 4096, root, L"bin\\64bit\\obs64.exe") || !obs_version_ok(path))
		append_missing(missing, L"OBS Studio x64 version 33.0.1 or later within 33.x");
	if (!exists(root, L"bin\\64bit\\obs.dll") || !exists(root, L"bin\\64bit\\obs-frontend-api.dll"))
		append_missing(missing, L"OBS Studio core and frontend API");
	if (!path_join(browser, 4096, root, L"core\\obs-browser") ||
	    !exists(browser, L"obs-browser.dll") || !exists(browser, L"obs-browser-page.exe") ||
	    !exists(browser, L"libcef.dll") || !exists(browser, L"icudtl.dat") || !exists(browser, L"resources.pak"))
		append_missing(missing, L"OBS Browser Source and its Chromium runtime (full OBS installer)");
	if (!exists(root, L"bin\\64bit\\Qt6Core.dll") || !exists(root, L"bin\\64bit\\Qt6Gui.dll") ||
	    !exists(root, L"bin\\64bit\\Qt6Widgets.dll"))
		append_missing(missing, L"OBS Qt runtime for the LAN Lens dock");
	UINT system_size = GetSystemDirectoryW(system, MAX_PATH);
	if (!system_size || system_size >= MAX_PATH || !path_join(bin, 4096, root, L"bin\\64bit")) {
		append_missing(missing, L"Supported Windows and Visual C++ runtime");
	} else {
		const wchar_t *vc[] = {L"msvcp140.dll", L"vcruntime140.dll", L"vcruntime140_1.dll"};
		bool vc_ok = true;
		for (size_t i = 0; i < sizeof(vc) / sizeof(vc[0]); ++i)
			vc_ok = vc_ok && (exists(system, vc[i]) || exists(bin, vc[i]));
		if (!vc_ok)
			append_missing(missing, L"Microsoft Visual C++ 2015–2022 Redistributable (x64)");
		if (!exists(system, L"ucrtbase.dll"))
			append_missing(missing, L"Windows Universal C Runtime");
	}
	if (wcslen(missing) != base_length)
		return stop_install(install, missing);
	return ERROR_SUCCESS;
}

