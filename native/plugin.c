// SPDX-License-Identifier: GPL-2.0-or-later
#include <stdio.h>
#include <sys/stat.h>
#include <string.h>
#include <obs-module.h>
#include <obs-frontend-api.h>
#include <util/platform.h>
#include <util/config-file.h>
#include "process.h"
#include "dock.h"

OBS_DECLARE_MODULE()
OBS_MODULE_AUTHOR("LAN Lens contributors")

#define LOCAL_URL "http://127.0.0.1:48640"


static bool exiting;

MODULE_EXPORT const char *obs_module_name(void)
{
	return "LAN Lens for OBS";
}

MODULE_EXPORT const char *obs_module_description(void)
{
	return "Pair LAN camera and display devices with OBS Browser Sources.";
}

static bool token_ok(const char *s, size_t len)
{
	if (strlen(s) != len)
		return false;
	for (; *s; ++s) {
		char c = *s;
		if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
		      (c >= '0' && c <= '9') || c == '_' || c == '-'))
			return false;
	}
	return true;
}

static void add_source(const char *id, const char *key)
{
	char url[128];
	char name[100];
	snprintf(url, sizeof(url), LOCAL_URL "/view#%s.%s", id, key);
	snprintf(name, sizeof(name), "LAN Lens · %.12s", id);

	obs_source_t *selected = obs_frontend_get_current_scene();
	obs_scene_t *scene = selected ? obs_scene_from_source(selected) : NULL;
	if (!scene) {
		blog(LOG_WARNING, "[LAN Lens] Select a scene before adding a feed.");
		obs_source_release(selected);
		return;
	}
	obs_source_t *source = obs_get_source_by_name(name);
	if (source) {
		obs_data_t *settings = obs_source_get_settings(source);
		bool match = strcmp(obs_source_get_id(source), "browser_source") == 0 &&
			strcmp(obs_data_get_string(settings, "url"), url) == 0;
		obs_data_release(settings);
		if (!match) {
			obs_source_release(source);
			source = NULL;
			snprintf(name, sizeof(name), "LAN Lens · %.12s · %.8s", id, key);
		}
	}
	if (!source) {
		obs_data_t *settings = obs_data_create();
		obs_data_set_string(settings, "url", url);
		obs_data_set_int(settings, "width", 1280);
		obs_data_set_int(settings, "height", 720);
		obs_data_set_bool(settings, "reroute_audio", true);
		obs_data_set_bool(settings, "is_local_file", false);
		obs_data_set_bool(settings, "shutdown", false);
		obs_data_set_bool(settings, "restart_when_active", false);
		obs_data_set_int(settings, "webpage_control_level", 0);
		source = obs_source_create("browser_source", name, settings, NULL);
		obs_data_release(settings);
	}
	if (source) {
		if (!obs_scene_find_source(scene, obs_source_get_name(source)))
			obs_scene_add(scene, source);
		obs_source_release(source);
		blog(LOG_INFO, "[LAN Lens] Camera feed is in the current scene.");
	} else {
		blog(LOG_WARNING, "[LAN Lens] Browser Source is unavailable.");
	}
	obs_source_release(selected);
}

static bool refresh_view(void *unused, obs_source_t *source)
{
	(void)unused;
	if (strcmp(obs_source_get_id(source), "browser_source") != 0)
		return true;
	obs_data_t *settings = obs_source_get_settings(source);
	const char prefix[] = LOCAL_URL "/view#";
	bool ours = strncmp(obs_data_get_string(settings, "url"), prefix, sizeof(prefix) - 1) == 0;
	obs_data_release(settings);
	if (ours) {
		obs_properties_t *props = obs_source_properties(source);
		if (props) {
			obs_property_t *refresh = obs_properties_get(props, "refreshnocache");
			if (refresh)
				obs_property_button_clicked(refresh, source);
			obs_properties_destroy(props);
		}
	}
	return true;
}

static void load_dashboard_url(void);

static void handle_line(void *data)
{
	char *line = data;
	if (!exiting) {
		if (!strcmp(line, "READY")) {
			load_dashboard_url();
			obs_enum_sources(refresh_view, NULL);
			blog(LOG_INFO, "[LAN Lens] Local camera server is ready.");
		} else if (!strncmp(line, "ADD ", 4)) {
			char id[13] = {0};
			char key[33] = {0};
			char extra;
			if (sscanf(line + 4, "%12s %32s %c", id, key, &extra) == 2 &&
			    token_ok(id, 12) && token_ok(key, 32))
				add_source(id, key);
		} else if (!strcmp(line, "EXIT") || !strncmp(line, "ERROR ", 6)) {
			set_dashboard_url(NULL);
			blog(LOG_WARNING, "[LAN Lens] Local server stopped. See its server.log in the plugin configuration folder.");
		}
	}
	bfree(line);
}

static void forward_line(const char *line)
{
	obs_queue_task(OBS_TASK_UI, handle_line, bstrdup(line), false);
}

static void load_dashboard_url(void)
{
	char *path = obs_module_config_path("service/dashboard-token");
	char *key = path ? os_quick_read_utf8_file(path) : NULL;
	if (key && token_ok(key, 32)) {
		char url[100];
		snprintf(url, sizeof(url), LOCAL_URL "/#%s", key);
		set_dashboard_url(url);
	} else {
		set_dashboard_url(NULL);
		blog(LOG_WARNING, "[LAN Lens] Could not read the dashboard token.");
	}
	bfree(key);
	bfree(path);
}

static void open_menu(void *unused)
{
	(void)unused;
	show_dashboard_dock(false);
}

static void on_event(enum obs_frontend_event event, void *unused)
{
	(void)unused;
	if (event == OBS_FRONTEND_EVENT_FINISHED_LOADING) {
		config_t *user = obs_frontend_get_user_config();
		if (user && !config_get_bool(user, "LanLens", "DockInitialized")) {
			show_dashboard_dock(true);
			config_set_bool(user, "LanLens", "DockInitialized", true);
		}
#ifdef _WIN32
		char *binary = obs_module_file("lanlens-server.exe");
#else
		char *binary = obs_module_file("lanlens-server");
#endif
		char *config = obs_module_config_path("service");
		if (!binary || !config || !start_companion(binary, config, forward_line)) {
			set_dashboard_url(NULL);
			blog(LOG_ERROR, "[LAN Lens] Could not start the local camera server.");
		}
		bfree(binary);
		bfree(config);
	} else if (event == OBS_FRONTEND_EVENT_EXIT) {
		exiting = true;
		destroy_dashboard_dock();
		stop_companion();
	}
}

bool obs_module_load(void)
{
	obs_frontend_add_tools_menu_item("LAN Lens for OBS", open_menu, NULL);
	obs_frontend_add_event_callback(on_event, NULL);
	blog(LOG_INFO, "[LAN Lens] Plugin loaded.");
	return true;
}

void obs_module_post_load(void)
{
	register_dashboard_dock();
}

void obs_module_unload(void)
{
	exiting = true;
	destroy_dashboard_dock();
	stop_companion();
}



