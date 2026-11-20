// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <stdbool.h>
#ifdef __cplusplus
extern "C" {
#endif

void register_dashboard_dock(void);
void show_dashboard_dock(bool attach);
void set_dashboard_url(const char *url);
void open_dashboard_in_browser(void);
void destroy_dashboard_dock(void);

#ifdef __cplusplus
}
#endif
