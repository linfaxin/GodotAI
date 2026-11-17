/**************************************************************************/
/*  main.cpp                                                              */
/**************************************************************************/
/*                         This file is part of:                          */
/*                             GODOT ENGINE                               */
/*                        https://godotengine.org                         */
/**************************************************************************/
/* Copyright (c) 2014-present Godot Engine contributors (see AUTHORS.md). */
/* Copyright (c) 2007-2014 Juan Linietsky, Ariel Manzur.                  */
/*                                                                        */
/* Permission is hereby granted, free of charge, to any person obtaining  */
/* a copy of this software and associated documentation files (the        */
/* "Software"), to deal in the Software without restriction, including    */
/* without limitation the rights to use, copy, modify, merge, publish,    */
/* distribute, sublicense, and/or sell copies of the Software, and to     */
/* permit persons to whom the Software is furnished to do so, subject to  */
/* the following conditions:                                              */
/*                                                                        */
/* The above copyright notice and this permission notice shall be         */
/* included in all copies or substantial portions of the Software.        */
/*                                                                        */
/* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,        */
/* EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF     */
/* MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. */
/* IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY   */
/* CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,   */
/* TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE      */
/* SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.                 */
/**************************************************************************/

#include "modules/modules_enabled.gen.h"

// Source fixture: exact Main::cleanup from Godot 4.6.1-stable.
void Main::cleanup(bool p_force) {
	GodotProfileZone("cleanup");
	OS::get_singleton()->benchmark_begin_measure("Shutdown", "Main::Cleanup");
	if (!p_force) {
		ERR_FAIL_COND(!_start_success);
	}

#ifdef DEBUG_ENABLED
	if (input) {
		input->flush_frame_parsed_events();
	}
#endif

	GDExtensionManager::get_singleton()->shutdown();

	for (int i = 0; i < TextServerManager::get_singleton()->get_interface_count(); i++) {
		TextServerManager::get_singleton()->get_interface(i)->cleanup();
	}

	if (movie_writer) {
		movie_writer->end();
	}

	ResourceLoader::clear_thread_load_tasks();

	ResourceLoader::remove_custom_loaders();
	ResourceSaver::remove_custom_savers();
	PropertyListHelper::clear_base_helpers();

	// Remove the lock file if the engine exits successfully. Some automated processes such as
	// --export/--import can bypass and/or finish faster than the existing check to remove the lock file.
	if (OS::get_singleton()->get_exit_code() == EXIT_SUCCESS) {
		OS::get_singleton()->remove_lock_file();
	}

	// Flush before uninitializing the scene, but delete the MessageQueue as late as possible.
	message_queue->flush();

	OS::get_singleton()->delete_main_loop();

	OS::get_singleton()->_cmdline.clear();
	OS::get_singleton()->_user_args.clear();
	OS::get_singleton()->_execpath = "";
	OS::get_singleton()->_local_clipboard = "";

	ResourceLoader::clear_translation_remaps();

	WorkerThreadPool::get_singleton()->exit_languages_threads();

	ScriptServer::finish_languages();

	// Sync pending commands that may have been queued from a different thread during ScriptServer finalization
	RenderingServer::get_singleton()->sync();

	//clear global shader variables before scene and other graphics stuff are deinitialized.
	rendering_server->global_shader_parameters_clear();

#ifndef XR_DISABLED
	if (xr_server) {
		// Now that we're unregistering properly in plugins we need to keep access to xr_server for a little longer
		// We do however unset our primary interface
		xr_server->set_primary_interface(Ref<XRInterface>());
	}
#endif // XR_DISABLED

#ifdef TOOLS_ENABLED
	GDExtensionManager::get_singleton()->deinitialize_extensions(GDExtension::INITIALIZATION_LEVEL_EDITOR);
	uninitialize_modules(MODULE_INITIALIZATION_LEVEL_EDITOR);
	unregister_editor_types();

#endif

	ImageLoader::cleanup();

	GDExtensionManager::get_singleton()->deinitialize_extensions(GDExtension::INITIALIZATION_LEVEL_SCENE);
	uninitialize_modules(MODULE_INITIALIZATION_LEVEL_SCENE);

	unregister_platform_apis();
	unregister_driver_types();
	unregister_scene_types();

	finalize_theme_db();

// Before deinitializing server extensions, finalize servers which may be loaded as extensions.
#ifndef NAVIGATION_2D_DISABLED
	NavigationServer2DManager::finalize_server();
	NavigationServer2DManager::finalize_server_manager();
#endif // NAVIGATION_2D_DISABLED
#ifndef NAVIGATION_3D_DISABLED
	NavigationServer3DManager::finalize_server();
	NavigationServer3DManager::finalize_server_manager();
#endif // NAVIGATION_3D_DISABLED
	finalize_physics();

	GDExtensionManager::get_singleton()->deinitialize_extensions(GDExtension::INITIALIZATION_LEVEL_SERVERS);
	uninitialize_modules(MODULE_INITIALIZATION_LEVEL_SERVERS);
	unregister_server_types();

	EngineDebugger::deinitialize();

#ifndef XR_DISABLED
	if (xr_server) {
		memdelete(xr_server);
	}
#endif // XR_DISABLED

	if (audio_server) {
		audio_server->finish();
		memdelete(audio_server);
	}

	if (camera_server) {
		memdelete(camera_server);
	}

	OS::get_singleton()->finalize();

	finalize_display();

	if (input) {
		memdelete(input);
	}

	if (packed_data) {
		memdelete(packed_data);
	}
	if (performance) {
		memdelete(performance);
	}
	if (input_map) {
		memdelete(input_map);
	}
	if (translation_server) {
		memdelete(translation_server);
	}
	if (tsman) {
		memdelete(tsman);
	}
#ifndef PHYSICS_3D_DISABLED
	if (physics_server_3d_manager) {
		memdelete(physics_server_3d_manager);
	}
#endif // PHYSICS_3D_DISABLED
#ifndef PHYSICS_2D_DISABLED
	if (physics_server_2d_manager) {
		memdelete(physics_server_2d_manager);
	}
#endif // PHYSICS_2D_DISABLED
	if (globals) {
		memdelete(globals);
	}

	if (OS::get_singleton()->is_restart_on_exit_set()) {
		//attempt to restart with arguments
		List<String> args = OS::get_singleton()->get_restart_on_exit_arguments();
		OS::get_singleton()->create_instance(args);
		OS::get_singleton()->set_restart_on_exit(false, List<String>()); //clear list (uses memory)
	}

	// Now should be safe to delete MessageQueue (famous last words).
	message_queue->flush();
	memdelete(message_queue);

#if defined(STEAMAPI_ENABLED)
	if (steam_tracker) {
		memdelete(steam_tracker);
	}
#endif

	unregister_core_driver_types();
	unregister_core_extensions();
	uninitialize_modules(MODULE_INITIALIZATION_LEVEL_CORE);

	if (engine) {
		memdelete(engine);
	}

	unregister_core_types();

	OS::get_singleton()->benchmark_end_measure("Shutdown", "Main::Cleanup");
	OS::get_singleton()->benchmark_dump();

	OS::get_singleton()->finalize_core();
}
