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

#include "main.h"
#include "modules/modules_enabled.gen.h" // For mono.

bool Main::iteration() {
	GodotProfileZone("Main::iteration");
	GodotProfileZoneGroupedFirst(_profile_zone, "prepare");
	iterating++;

	const uint64_t ticks = OS::get_singleton()->get_ticks_usec();
	Engine::get_singleton()->_frame_ticks = ticks;
	main_timer_sync.set_cpu_ticks_usec(ticks);
	main_timer_sync.set_fixed_fps(fixed_fps);

	const uint64_t ticks_elapsed = ticks - last_ticks;

	const int physics_ticks_per_second = Engine::get_singleton()->get_user_physics_ticks_per_second();
	const double physics_step = 1.0 / physics_ticks_per_second;

	const double time_scale = Engine::get_singleton()->get_effective_time_scale();

	MainFrameTime advance = main_timer_sync.advance(physics_step, physics_ticks_per_second);
	double process_step = advance.process_step;
	double scaled_step = process_step * time_scale;

	Engine::get_singleton()->_process_step = process_step;
	Engine::get_singleton()->_physics_interpolation_fraction = advance.interpolation_fraction;

	uint64_t physics_process_ticks = 0;
	uint64_t process_ticks = 0;
#if !defined(NAVIGATION_2D_DISABLED) || !defined(NAVIGATION_3D_DISABLED)
	uint64_t navigation_process_ticks = 0;
#endif // !defined(NAVIGATION_2D_DISABLED) || !defined(NAVIGATION_3D_DISABLED)

	frame += ticks_elapsed;

	last_ticks = ticks;

	const int max_physics_steps = Engine::get_singleton()->get_user_max_physics_steps_per_frame();
	if (fixed_fps == -1 && advance.physics_steps > max_physics_steps) {
		process_step -= (advance.physics_steps - max_physics_steps) * physics_step;
		advance.physics_steps = max_physics_steps;
	}

	bool exit = false;

	// process all our active interfaces
#ifndef XR_DISABLED
	GodotProfileZoneGrouped(_profile_zone, "xr_server->_process");
	XRServer::get_singleton()->_process();
#endif // XR_DISABLED

	GodotProfileZoneGrouped(_profile_zone, "physics");
	for (int iters = 0; iters < advance.physics_steps; ++iters) {
		GodotProfileZone("Physics Step");
		GodotProfileZoneGroupedFirst(_physics_zone, "setup");
		if (Input::get_singleton()->is_agile_input_event_flushing()) {
			Input::get_singleton()->flush_buffered_events();
		}

		Engine::get_singleton()->_in_physics = true;
		Engine::get_singleton()->_physics_frames++;

		uint64_t physics_begin = OS::get_singleton()->get_ticks_usec();

		// Prepare the fixed timestep interpolated nodes BEFORE they are updated
		// by the physics server, otherwise the current and previous transforms
		// may be the same, and no interpolation takes place.
		GodotProfileZoneGrouped(_physics_zone, "main loop iteration prepare");
		OS::get_singleton()->get_main_loop()->iteration_prepare();

#ifndef PHYSICS_3D_DISABLED
		GodotProfileZoneGrouped(_physics_zone, "PhysicsServer3D::sync");
		PhysicsServer3D::get_singleton()->sync();
		PhysicsServer3D::get_singleton()->flush_queries();
#endif // PHYSICS_3D_DISABLED

#ifndef PHYSICS_2D_DISABLED
		GodotProfileZoneGrouped(_physics_zone, "PhysicsServer2D::sync");
		PhysicsServer2D::get_singleton()->sync();
		PhysicsServer2D::get_singleton()->flush_queries();
#endif // PHYSICS_2D_DISABLED

		GodotProfileZoneGrouped(_physics_zone, "physics_process");
		if (OS::get_singleton()->get_main_loop()->physics_process(physics_step * time_scale)) {
#ifndef PHYSICS_3D_DISABLED
			PhysicsServer3D::get_singleton()->end_sync();
#endif // PHYSICS_3D_DISABLED
#ifndef PHYSICS_2D_DISABLED
			PhysicsServer2D::get_singleton()->end_sync();
#endif // PHYSICS_2D_DISABLED

			Engine::get_singleton()->_in_physics = false;
			exit = true;
			break;
		}

#if !defined(NAVIGATION_2D_DISABLED) || !defined(NAVIGATION_3D_DISABLED)
		uint64_t navigation_begin = OS::get_singleton()->get_ticks_usec();

#ifndef NAVIGATION_2D_DISABLED
		GodotProfileZoneGrouped(_profile_zone, "NavigationServer2D::physics_process");
		NavigationServer2D::get_singleton()->physics_process(physics_step * time_scale);
#endif // NAVIGATION_2D_DISABLED
#ifndef NAVIGATION_3D_DISABLED
		GodotProfileZoneGrouped(_profile_zone, "NavigationServer3D::physics_process");
		NavigationServer3D::get_singleton()->physics_process(physics_step * time_scale);
#endif // NAVIGATION_3D_DISABLED

		navigation_process_ticks = MAX(navigation_process_ticks, OS::get_singleton()->get_ticks_usec() - navigation_begin); // keep the largest one for reference
		navigation_process_max = MAX(OS::get_singleton()->get_ticks_usec() - navigation_begin, navigation_process_max);

		message_queue->flush();
#endif // !defined(NAVIGATION_2D_DISABLED) || !defined(NAVIGATION_3D_DISABLED)

#ifndef PHYSICS_3D_DISABLED
		GodotProfileZoneGrouped(_profile_zone, "3D physics");
		PhysicsServer3D::get_singleton()->end_sync();
		PhysicsServer3D::get_singleton()->step(physics_step * time_scale);
#endif // PHYSICS_3D_DISABLED

#ifndef PHYSICS_2D_DISABLED
		GodotProfileZoneGrouped(_profile_zone, "2D physics");
		PhysicsServer2D::get_singleton()->end_sync();
		PhysicsServer2D::get_singleton()->step(physics_step * time_scale);
#endif // PHYSICS_2D_DISABLED

		message_queue->flush();

		GodotProfileZoneGrouped(_profile_zone, "main loop iteration end");
		OS::get_singleton()->get_main_loop()->iteration_end();

		physics_process_ticks = MAX(physics_process_ticks, OS::get_singleton()->get_ticks_usec() - physics_begin); // keep the largest one for reference
		physics_process_max = MAX(OS::get_singleton()->get_ticks_usec() - physics_begin, physics_process_max);

		Engine::get_singleton()->_in_physics = false;
	}

	if (Input::get_singleton()->is_agile_input_event_flushing()) {
		Input::get_singleton()->flush_buffered_events();
	}

	uint64_t process_begin = OS::get_singleton()->get_ticks_usec();

	GodotProfileZoneGrouped(_profile_zone, "process");
	if (OS::get_singleton()->get_main_loop()->process(process_step * time_scale)) {
		exit = true;
	}
	message_queue->flush();

#ifndef NAVIGATION_2D_DISABLED
	GodotProfileZoneGrouped(_profile_zone, "process 2D navigation");
	NavigationServer2D::get_singleton()->process(process_step * time_scale);
#endif // NAVIGATION_2D_DISABLED
#ifndef NAVIGATION_3D_DISABLED
	GodotProfileZoneGrouped(_profile_zone, "process 3D navigation");
	NavigationServer3D::get_singleton()->process(process_step * time_scale);
#endif // NAVIGATION_3D_DISABLED

	GodotProfileZoneGrouped(_profile_zone, "RenderingServer::sync");
	RenderingServer::get_singleton()->sync(); //sync if still drawing from previous frames.

	GodotProfileZoneGrouped(_profile_zone, "RenderingServer::draw");
	const bool has_pending_resources_for_processing = RD::get_singleton() && RD::get_singleton()->has_pending_resources_for_processing();
	bool wants_present = (DisplayServer::get_singleton()->can_any_window_draw() ||
								 DisplayServer::get_singleton()->has_additional_outputs()) &&
			RenderingServer::get_singleton()->is_render_loop_enabled();

	if (wants_present || has_pending_resources_for_processing) {
		wants_present |= force_redraw_requested;
		if ((!force_redraw_requested) && OS::get_singleton()->is_in_low_processor_usage_mode()) {
			if (RenderingServer::get_singleton()->has_changed()) {
				RenderingServer::get_singleton()->draw(wants_present, scaled_step); // flush visual commands
				Engine::get_singleton()->increment_frames_drawn();
			}
		} else {
			RenderingServer::get_singleton()->draw(wants_present, scaled_step); // flush visual commands
			Engine::get_singleton()->increment_frames_drawn();
			force_redraw_requested = false;
		}
	}

	process_ticks = OS::get_singleton()->get_ticks_usec() - process_begin;
	process_max = MAX(process_ticks, process_max);
	uint64_t frame_time = OS::get_singleton()->get_ticks_usec() - ticks;

	GodotProfileZoneGrouped(_profile_zone, "GDExtensionManager::frame");
	GDExtensionManager::get_singleton()->frame();

	GodotProfileZoneGrouped(_profile_zone, "ScriptServer::frame");
	for (int i = 0; i < ScriptServer::get_language_count(); i++) {
		ScriptServer::get_language(i)->frame();
	}

	GodotProfileZoneGrouped(_profile_zone, "AudioServer::update");
	AudioServer::get_singleton()->update();

	if (EngineDebugger::is_active()) {
		EngineDebugger::get_singleton()->iteration(frame_time, process_ticks, physics_process_ticks, physics_step);
	}

	frames++;
	Engine::get_singleton()->_process_frames++;

	if (frame > 1000000) {
		// Wait a few seconds before printing FPS, as FPS reporting just after the engine has started is inaccurate.
		if (hide_print_fps_attempts == 0) {
			if (editor || project_manager) {
				if (print_fps) {
					print_line(vformat("Editor FPS: %d (%s mspf)", frames, rtos(1000.0 / frames).pad_decimals(2)));
				}
			} else if (print_fps || GLOBAL_GET("debug/settings/stdout/print_fps")) {
				print_line(vformat("Project FPS: %d (%s mspf)", frames, rtos(1000.0 / frames).pad_decimals(2)));
			}
		} else {
			hide_print_fps_attempts--;
		}

		Engine::get_singleton()->_fps = frames;
		performance->set_process_time(USEC_TO_SEC(process_max));
		performance->set_physics_process_time(USEC_TO_SEC(physics_process_max));
		performance->set_navigation_process_time(USEC_TO_SEC(navigation_process_max));
		process_max = 0;
		physics_process_max = 0;
		navigation_process_max = 0;

		frame %= 1000000;
		frames = 0;
	}

	iterating--;

	if (movie_writer) {
		GodotProfileZoneGrouped(_profile_zone, "movie_writer->add_frame");
		movie_writer->add_frame();
	}

#ifdef TOOLS_ENABLED
	bool quit_after_timeout = false;
#endif
	if ((quit_after > 0) && (Engine::get_singleton()->_process_frames >= quit_after)) {
#ifdef TOOLS_ENABLED
		quit_after_timeout = true;
#endif
		exit = true;
	}

#ifdef TOOLS_ENABLED
	if (wait_for_import && EditorFileSystem::get_singleton() && EditorFileSystem::get_singleton()->doing_first_scan()) {
		exit = false;
	}
#endif

	if (fixed_fps != -1) {
		return exit;
	}

	SceneTree *scene_tree = SceneTree::get_singleton();
	bool wake_for_events = scene_tree && scene_tree->is_accessibility_enabled();

	GodotProfileZoneGrouped(_profile_zone, "OS::add_frame_delay");
	OS::get_singleton()->add_frame_delay(DisplayServer::get_singleton()->window_can_draw(), wake_for_events);

#ifdef TOOLS_ENABLED
	if (auto_build_solutions) {
		auto_build_solutions = false;
		// Only relevant when running the editor.
		if (!editor) {
			OS::get_singleton()->set_exit_code(EXIT_FAILURE);
			ERR_FAIL_V_MSG(true,
					"Command line option --build-solutions was passed, but no project is being edited. Aborting.");
		}
		if (!EditorNode::get_singleton()->call_build()) {
			OS::get_singleton()->set_exit_code(EXIT_FAILURE);
			ERR_FAIL_V_MSG(true,
					"Command line option --build-solutions was passed, but the build callback failed. Aborting.");
		}
	}
#endif

#ifdef TOOLS_ENABLED
	if (exit && quit_after_timeout && EditorNode::get_singleton()) {
		EditorNode::get_singleton()->unload_editor_addons();
	}
#endif

	return exit;
}

void Main::force_redraw() {
}
