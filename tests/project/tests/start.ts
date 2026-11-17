import { is_instance_valid, Node, PackedScene, ResourceLoader } from "godot";
import {
	getActiveAsyncTestCount,
	hasActiveAsyncTests,
	hasTestFailure,
	reportTestCompleted,
	reportTestFailure,
} from "./test-status";

const SCENE_SETTLE_DELAY_MS = 100;
const ASYNC_TEST_DRAIN_TIMEOUT_MS = 20000;
const ASYNC_TEST_DRAIN_POLL_MS = 10;

export default class Start extends Node {
    async _ready() {
        const createdScenes: Node[] = [];
        try {
            const scenes = [
                "res://tests/resource/Resource.tscn",
                "res://tests/singleton/Singleton.tscn",
                "res://tests/extend/Extend.tscn",
                "res://tests/papaparse/Papaparse.tscn",
                "res://tests/os-executor/OSExecutor.tscn",
                "res://tests/worker/Worker.tscn",
            ];

            for (const scene of scenes) {
                if (hasTestFailure()) {
                    break;
                }
                console.log("Loading scene", scene);

                const loadedScene = ResourceLoader.load(scene);
                if (!(loadedScene instanceof PackedScene)) {
                    throw new Error(`failed to load PackedScene: ${scene}`);
                }
                const sceneAsNode = loadedScene.instantiate();
                createdScenes.push(sceneAsNode);

                this.get_tree().root?.call_deferred("add_child", sceneAsNode);
                await new Promise((resolve) => setTimeout(resolve, SCENE_SETTLE_DELAY_MS));
                this.get_tree().root?.call_deferred("remove_child", sceneAsNode);
            }

            const asyncDrainStartedAt = Date.now();
			while (hasActiveAsyncTests() && !hasTestFailure()) {
				const elapsedMs = Date.now() - asyncDrainStartedAt;
				if (elapsedMs > ASYNC_TEST_DRAIN_TIMEOUT_MS) {
					throw new Error(
						`async tests did not drain before completion timeout (remaining=${String(getActiveAsyncTestCount())}, timeoutMs=${String(ASYNC_TEST_DRAIN_TIMEOUT_MS)})`
					);
				}
				await new Promise((resolve) => setTimeout(resolve, ASYNC_TEST_DRAIN_POLL_MS));
			}

        } catch (error) {
            reportTestFailure("start", error);
        } finally {
            try {
                // remove_child only detaches: retain each fixture until its
                // async tests settle, then wait for actual queued destruction.
                for (const scene of createdScenes) {
                    if (is_instance_valid(scene)) scene.queue_free();
                }
                const cleanupStartedAt = Date.now();
                while (createdScenes.some((scene) => is_instance_valid(scene))) {
                    if (Date.now() - cleanupStartedAt > ASYNC_TEST_DRAIN_TIMEOUT_MS) {
                        throw new Error("test scene cleanup did not reach native destruction");
                    }
                    await new Promise((resolve) => setTimeout(resolve, ASYNC_TEST_DRAIN_POLL_MS));
                }
                createdScenes.length = 0;
                reportTestCompleted();
            } catch (error) {
                reportTestFailure("scene-cleanup", error);
            }
            this.get_tree().quit();
        }
    }
}
