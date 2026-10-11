package app.eternal.patches.youtube.history

import app.morphe.patcher.extensions.InstructionExtensions.addInstructionsWithLabels
import app.morphe.patcher.patch.ApkFileType
import app.morphe.patcher.patch.AppTarget
import app.morphe.patcher.patch.BytecodePatchContext
import app.morphe.patcher.patch.Compatibility
import app.morphe.patcher.patch.bytecodePatch
import app.morphe.patcher.patch.resourcePatch
import app.morphe.util.findFreeRegister

private const val REGISTER_METHOD =
    "Lapp/morphe/extension/youtube/patches/eternalhistory/EternalHistoryAddOn;->register()V"
private const val WATCHED_FILTER =
    "Lapp/morphe/extension/youtube/patches/eternalhistory/EternalWatchedFilter;"
private const val LITHO_FILTER_CLASS =
    "Lapp/morphe/extension/shared/patches/components/LithoFilterPatch;"
private const val CONTEXT_INTERFACE =
    "Lapp/morphe/extension/shared/patches/components/ContextInterface;"

private val YOUTUBE = Compatibility(
    packageName = "com.google.android.youtube",
    name = "YouTube",
    apkFileType = ApkFileType.APK_REQUIRED,
    appIconColor = 0xFF0033,
    signatures = setOf(
        "5aad2bee6db95d17e05a08d7d1e64c10a1511879154483916b6ae6c7fd9cb0c6",
        "3d7a1223019aa39d9ea0e3436ab7c0896bfb4fb679f4de5fe7c23f326c8f994a"
    ),
    targets = listOf(
        // MORPHE_COMPAT_START
        AppTarget(
            version = "21.20.405",
            minSdk = 28
        ),
        AppTarget(
            version = "21.16.256",
            minSdk = 28
        ),
        AppTarget(
            version = "20.51.39",
            minSdk = 28
        ),
        AppTarget(
            version = "20.21.37",
            minSdk = 26
        )
        // MORPHE_COMPAT_END
    )
)

/**
 * Adds a conservative pre-filter to Morphe's already-patched Litho filtering entry point.
 * If the official Litho hook is not present in the selected Morphe patch set, direct D1 recording
 * still works; only watched-card hiding is unavailable.
 */
context(context: BytecodePatchContext)
private fun installWatchedCardHook() {
    val cls = context.mutableClassDefByOrNull(LITHO_FILTER_CLASS) ?: return
    val method = cls.methods.firstOrNull {
        it.name == "isFiltered" && it.returnType == "Z" && it.parameters.size == 4
    } ?: return

    method.apply {
        val free = findFreeRegister(0)
        addInstructionsWithLabels(
            0,
            """
                invoke-static { p0, p1 }, $WATCHED_FILTER->shouldHide($CONTEXT_INTERFACE[B)Z
                move-result v$free
                if-eqz v$free, :eternal_history_continue
                const/4 v$free, 0x1
                return v$free
                :eternal_history_continue
                nop
            """.trimIndent()
        )
    }
}

private val eternalHistoryBytecodePatch = bytecodePatch {
    extendWith("extensions/extension.mpe")
    finalize {
        registerAddOn(REGISTER_METHOD)
        installWatchedCardHook()
    }
}

private val eternalHistoryResourcePatch = resourcePatch {
    execute { addEternalResources() }
}

@Suppress("unused")
val eternalHistoryPatch = bytecodePatch(
    name = "Eternal YouTube History",
    description = "Writes Android YouTube watch/progress directly to your private Eternal D1 ledger and can hide watched feed cards from the local cache.",
    default = false
) {
    compatibleWith(YOUTUBE)
    dependsOn(eternalHistoryResourcePatch, eternalHistoryBytecodePatch)
    execute { }
}
