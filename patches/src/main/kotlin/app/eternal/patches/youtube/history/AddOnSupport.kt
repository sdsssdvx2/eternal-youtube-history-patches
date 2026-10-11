package app.eternal.patches.youtube.history

import app.morphe.patcher.extensions.InstructionExtensions.addInstruction
import app.morphe.patcher.patch.BytecodePatchContext
import app.morphe.patcher.patch.PatchException
import app.morphe.patcher.patch.ResourcePatchContext
import app.morphe.util.forEachChildElement
import app.morphe.util.getNode
import app.morphe.util.inputStreamFromBundledResource
import com.android.tools.smali.dexlib2.AccessFlags

private const val ADD_ON_MANAGER_CLASS_DESCRIPTOR = "Lapp/morphe/extension/youtube/addon/AddOnManager;"
private const val ADD_ON_MANAGER_REGISTER_METHOD_NAME = "registerAddOns"
private const val ADD_ON_PREFERENCES_FILE_PATH = "morphe_addon_prefs.xml"

context(context: BytecodePatchContext)
internal fun registerAddOn(registrationMethodDescriptor: String) {
    val manager = context.mutableClassDefByOrNull(ADD_ON_MANAGER_CLASS_DESCRIPTOR)
        ?: throw PatchException("Eternal History requires Morphe official add-on support")
    val method = manager.methods.firstOrNull {
        it.name == ADD_ON_MANAGER_REGISTER_METHOD_NAME && it.returnType == "V" &&
            it.parameters.isEmpty() && AccessFlags.PUBLIC.isSet(it.accessFlags) && AccessFlags.STATIC.isSet(it.accessFlags)
    } ?: throw PatchException("Eternal History could not find AddOnManager.registerAddOns()")
    method.addInstruction(0, "invoke-static { }, $registrationMethodDescriptor")
}

context(context: ResourcePatchContext)
internal fun addEternalResources() {
    val source = inputStreamFromBundledResource("addresources", "values/youtube/strings.xml")
        ?: throw PatchException("Eternal History strings are missing")
    val destinationPath = "res/values/strings.xml"
    val destination = context[destinationPath]
    if (!destination.exists()) {
        destination.parentFile?.mkdirs()
        destination.writeText("<?xml version=\"1.0\" encoding=\"utf-8\"?><resources></resources>")
    }
    source.use { stream ->
        context.document(destinationPath).use { dst ->
            val root = dst.getNode("resources")
            context.document(stream).use { src ->
                src.getNode("resources").forEachChildElement { root.appendChild(dst.importNode(it, true)) }
            }
        }
    }

    val prefs = context[ADD_ON_PREFERENCES_FILE_PATH]
    if (!prefs.exists()) {
        prefs.parentFile?.mkdirs()
        prefs.writeText(
            """
            <?xml version="1.0" encoding="utf-8"?>
            <morphe-add-on-preferences xmlns:android="http://schemas.android.com/apk/res/android">
              <screen key="morphe_settings_screen_12_video">
                <PreferenceScreen android:key="morphe_eternal_history_screen_sort_by_key" android:title="@string/morphe_eternal_history_screen_title" android:summary="@string/morphe_eternal_history_screen_summary">
                  <SwitchPreference android:key="morphe_eternal_history_enabled" android:title="@string/morphe_eternal_history_enabled_title" android:summary="@string/morphe_eternal_history_enabled_summary" />
                  <app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_worker_url" android:title="@string/morphe_eternal_history_worker_url_title" android:summary="@string/morphe_eternal_history_worker_url_summary" android:inputType="textUri" />
                  <app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_api_token" android:title="@string/morphe_eternal_history_api_token_title" android:summary="@string/morphe_eternal_history_api_token_summary" android:inputType="textPassword" />
                  <app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_min_seconds" android:title="@string/morphe_eternal_history_min_seconds_title" android:summary="@string/morphe_eternal_history_min_seconds_summary" android:inputType="number" />
                  <app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_progress_step" android:title="@string/morphe_eternal_history_progress_step_title" android:summary="@string/morphe_eternal_history_progress_step_summary" android:inputType="number" />
                  <SwitchPreference android:key="morphe_eternal_history_sync_cache" android:title="@string/morphe_eternal_history_sync_cache_title" android:summary="@string/morphe_eternal_history_sync_cache_summary" />
                  <ListPreference android:key="morphe_eternal_history_feed_mode" android:title="@string/morphe_eternal_history_feed_mode_title" android:summary="@string/morphe_eternal_history_feed_mode_summary" android:entries="@array/morphe_eternal_history_feed_mode_entries" android:entryValues="@array/morphe_eternal_history_feed_mode_values" android:defaultValue="none" />
                  <app.morphe.extension.shared.settings.preference.ResettableEditTextPreference android:key="morphe_eternal_history_hide_min_progress" android:title="@string/morphe_eternal_history_visual_min_progress_title" android:summary="@string/morphe_eternal_history_visual_min_progress_summary" android:inputType="number" />
                  <Preference android:key="morphe_eternal_history_feed_note" android:title="@string/morphe_eternal_history_feed_note_title" android:summary="@string/morphe_eternal_history_feed_note_summary" android:selectable="false" />
                </PreferenceScreen>
              </screen>
            </morphe-add-on-preferences>
            """.trimIndent()
        )
    }
}
