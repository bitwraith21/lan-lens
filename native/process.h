// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <stdbool.h>

typedef void (*line_callback)(const char *);
bool start_companion(const char *binary, const char *config, line_callback callback);
void stop_companion(void);
bool open_dashboard(const char *url);
