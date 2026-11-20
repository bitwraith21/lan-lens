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

static void feed_url(char *url, size_t size, const char *id, const char *key)
{
	snprintf(url, size, LOCAL_URL "/view#%s.%s", id, key);
}

static bool source_matches(obs_source_t *source, const char *url)
{
	if (strcmp(obs_source_get_id(source), "browser_source") != 0)
		return false;
	obs_data_t *settings = obs_source_get_settings(source);
	bool matches = !obs_data_get_bool(settings, "is_local_file") &&
		       !strcmp(obs_data_get_string(settings, "url"), url);
	obs_data_release(settings);
	return matches;
}

struct scene_search {
	const char *url;
	obs_source_t *source;
	DARRAY(obs_scene_t *) visited;
	bool found;
};

static void search_scene(obs_scene_t *scene, struct scene_search *search);

static bool search_item(obs_scene_t *scene, obs_sceneitem_t *item, void *data)
{
	(void)scene;
	struct scene_search *search = data;
	obs_source_t *source = obs_sceneitem_get_source(item);
	search->found = search->source ? source == search->source : source_matches(source, search->url);
	if (!search->found) {
		obs_scene_t *nested = obs_sceneitem_is_group(item) ? obs_sceneitem_group_get_scene(item)
								  : obs_scene_from_source(source);
		search_scene(nested, search);
	}
	return !search->found;
}

static void search_scene(obs_scene_t *scene, struct scene_search *search)
{
	if (!scene || da_find(search->visited, &scene, 0) != DARRAY_INVALID)
		return;
	da_push_back(search->visited, &scene);
	obs_scene_enum_items(scene, search_item, search);
}

static bool scene_has(obs_scene_t *scene, obs_source_t *source, const char *url)
{
	struct scene_search search = {.source = source, .url = url};
	search_scene(scene, &search);
	da_free(search.visited);
	return search.found;
}

struct source_search {
	const char *url;
	obs_source_t *source;
};

static bool find_bound_source(void *data, obs_source_t *source)
{
	struct source_search *search = data;
	if (!source_matches(source, search->url))
		return true;
	search->source = obs_source_get_ref(source);
	return search->source == NULL;
}

static bool vacant_source(obs_data_t *settings)
{
 return !obs_data_get_bool(settings, "is_local_file") &&
        !strcmp(obs_data_get_string(settings, "url"), "about:blank");
}

static const char *bind_source(const char *id, const char *key, const char *uuid)
{
 obs_source_t *source = obs_get_source_by_uuid(uuid);
 if (!source)
  return "occupied";
 const char *result = "occupied";
 if (!strcmp(obs_source_get_id(source), "browser_source")) {
  char url[128];
  feed_url(url, sizeof(url), id, key);
  obs_data_t *settings = obs_source_get_settings(source);
  if (source_matches(source, url)) {
   result = "bound";
  } else if (vacant_source(settings)) {
   struct source_search search = {.url = url};
   obs_enum_sources(find_bound_source, &search);
   if (search.source) {
    result = "feed-bound";
    obs_source_release(search.source);
   } else {
    obs_data_set_string(settings, "url", url);
    obs_source_update(source, settings);
    result = "bound";
   }
  }
  obs_data_release(settings);
 }
 obs_source_release(source);
 return result;
}

static const char *add_source(const char *id, const char *key)
{
	char url[128];
	feed_url(url, sizeof(url), id, key);
	obs_source_t *selected = obs_frontend_preview_program_mode_active()
					 ? obs_frontend_get_current_preview_scene()
					 : obs_frontend_get_current_scene();
	obs_scene_t *scene = selected ? obs_scene_from_source(selected) : NULL;
	if (!scene) {
		obs_source_release(selected);
		return "no-scene";
	}
	if (scene_has(scene, NULL, url)) {
		obs_source_release(selected);
		return "already-present";
	}

	struct source_search search = {.url = url};
	obs_enum_sources(find_bound_source, &search);
	obs_source_t *source = search.source;
	if (!source) {
		char base[100];
		char name[120];
		snprintf(base, sizeof(base), "LAN Lens · %.12s", id);
		snprintf(name, sizeof(name), "%s", base);
		for (unsigned suffix = 2;; ++suffix) {
			obs_source_t *existing = obs_get_source_by_name(name);
			if (!existing)
				break;
			obs_source_release(existing);
			snprintf(name, sizeof(name), "%s · %u", base, suffix);
		}
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
	bool added = source && obs_scene_add(scene, source);
	obs_source_release(source);
	obs_source_release(selected);
	return added ? "added" : "failed";
}

struct binding_snapshot {
	struct obs_frontend_source_list scenes;
	obs_data_array_t *bindings;
};

static bool record_binding(void *data, obs_source_t *source)
{
	if (strcmp(obs_source_get_id(source), "browser_source") != 0)
		return true;

	struct binding_snapshot *snapshot = data;
	const char prefix[] = LOCAL_URL "/view#";
	obs_data_t *settings = obs_source_get_settings(source);
	const char *url = obs_data_get_string(settings, "url");
	char id[13] = {0}, key[33] = {0};
	bool bound = !obs_data_get_bool(settings, "is_local_file") &&
		     !strncmp(url, prefix, sizeof(prefix) - 1) &&
		     strlen(url + sizeof(prefix) - 1) == 45 &&
		     url[sizeof(prefix) - 1 + 12] == '.';
	if (bound) {
		memcpy(id, url + sizeof(prefix) - 1, 12);
		memcpy(key, url + sizeof(prefix) - 1 + 13, 32);
		bound = token_ok(id, 12) && token_ok(key, 32);
	}
	bool vacant = vacant_source(settings);
 obs_data_release(settings);
 if (!bound && !vacant)
  return true;

	obs_data_t *binding = obs_data_create();
	if (bound) {
  obs_data_set_string(binding, "id", id);
  obs_data_set_string(binding, "key", key);
 }
	obs_data_set_string(binding, "name", obs_source_get_name(source));
	obs_data_set_string(binding, "uuid", obs_source_get_uuid(source));
	obs_data_array_t *scenes = obs_data_array_create();
	for (size_t i = 0; i < snapshot->scenes.sources.num; ++i) {
		obs_source_t *scene = snapshot->scenes.sources.array[i];
		if (!scene_has(obs_scene_from_source(scene), source, NULL))
			continue;
		obs_data_t *entry = obs_data_create();
		obs_data_set_string(entry, "name", obs_source_get_name(scene));
		obs_data_array_push_back(scenes, entry);
		obs_data_release(entry);
	}
	obs_data_set_array(binding, "scenes", scenes);
	obs_data_array_release(scenes);
	obs_data_array_push_back(snapshot->bindings, binding);
	obs_data_release(binding);
	return true;
}

static void publish_bindings(void)
{
	struct binding_snapshot snapshot = {0};
	snapshot.bindings = obs_data_array_create();
	obs_frontend_get_scenes(&snapshot.scenes);
	obs_enum_sources(record_binding, &snapshot);
	obs_frontend_source_list_free(&snapshot.scenes);

	obs_data_t *data = obs_data_create();
	obs_data_set_array(data, "bindings", snapshot.bindings);
	char *path = obs_module_config_path("service/obs-bindings.json");
	if (path)
		obs_data_save_json_safe(data, path, "tmp", NULL);
	bfree(path);
	obs_data_release(data);
	obs_data_array_release(snapshot.bindings);
}

static bool unlink_source(void *url, obs_source_t *source)
{
	if (source_matches(source, url)) {
		obs_data_t *settings = obs_source_get_settings(source);
		obs_data_set_string(settings, "url", "about:blank");
		obs_source_update(source, settings);
		obs_data_release(settings);
	}
	return true;
}

static void report_add(const char *request, const char *result)
{
	char name[64];
	snprintf(name, sizeof(name), "service/obs-add-%s.txt", request);
	char *path = obs_module_config_path(name);
	if (path)
		os_quick_write_utf8_file_safe(path, result, strlen(result), false, "tmp", NULL);
	bfree(path);
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
			publish_bindings();
			blog(LOG_INFO, "[LAN Lens] Local camera server is ready.");
		} else if (!strcmp(line, "SNAPSHOT")) {
			publish_bindings();
		} else if (!strcmp(line, "OPEN_BROWSER")) {
			open_dashboard_in_browser();
		} else if (!strcmp(line, "OPEN_KOFI")) {
			if (!open_dashboard("https://ko-fi.com/bitwraith21"))
				blog(LOG_WARNING, "[LAN Lens] Could not open Ko-fi in the default browser.");
		} else if (!strncmp(line, "ADD ", 4)) {
			char id[13] = {0}, key[33] = {0}, request[13] = {0}, extra;
			if (sscanf(line + 4, "%12s %32s %12s %c", id, key, request, &extra) == 3 &&
			    token_ok(id, 12) && token_ok(key, 32) && token_ok(request, 12)) {
				const char *result = add_source(id, key);
				publish_bindings();
				report_add(request, result);
			}
		} else if (!strncmp(line, "BIND ", 5)) {
   char id[13] = {0}, key[33] = {0}, request[13] = {0}, uuid[37] = {0}, extra;
   if (sscanf(line + 5, "%12s %32s %12s %36s %c", id, key, request, uuid, &extra) == 4 &&
       token_ok(id, 12) && token_ok(key, 32) && token_ok(request, 12) && token_ok(uuid, 36)) {
    const char *result = bind_source(id, key, uuid);
    publish_bindings();
    report_add(request, result);
   }
  } else if (!strncmp(line, "UNBIND ", 7)) {
			char id[13] = {0}, key[33] = {0}, extra;
			if (sscanf(line + 7, "%12s %32s %c", id, key, &extra) == 2 &&
			    token_ok(id, 12) && token_ok(key, 32)) {
				char url[128];
				feed_url(url, sizeof(url), id, key);
				obs_enum_sources(unlink_source, url);
				publish_bindings();
			}
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



