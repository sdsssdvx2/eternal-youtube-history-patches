package app.eternal.patches.youtube.history

import app.morphe.patcher.Fingerprint
import app.morphe.patcher.extensions.InstructionExtensions.addInstructionsWithLabels
import app.morphe.patcher.extensions.InstructionExtensions.getInstruction
import app.morphe.patcher.methodCall
import app.morphe.patcher.patch.ApkFileType
import app.morphe.patcher.patch.AppTarget
import app.morphe.patcher.patch.BytecodePatchContext
import app.morphe.patcher.patch.Compatibility
import app.morphe.patcher.patch.PatchException
import app.morphe.patcher.patch.bytecodePatch
import app.morphe.patcher.patch.resourcePatch
import app.morphe.patcher.util.smali.ExternalLabel
import app.morphe.util.findFreeRegister
import com.android.tools.smali.dexlib2.AccessFlags
import com.android.tools.smali.dexlib2.Opcode
import com.android.tools.smali.dexlib2.iface.instruction.FiveRegisterInstruction
import com.android.tools.smali.dexlib2.iface.instruction.ReferenceInstruction
import com.android.tools.smali.dexlib2.iface.instruction.TwoRegisterInstruction
import com.android.tools.smali.dexlib2.iface.reference.FieldReference
import com.android.tools.smali.dexlib2.iface.reference.MethodReference

private const val REGISTER_METHOD =
    "Lapp/morphe/extension/youtube/patches/eternalhistory/EternalHistoryAddOn;->register()V"
private const val WATCHED_FILTER =
    "Lapp/morphe/extension/youtube/patches/eternalhistory/EternalWatchedFilter;"
private const val WATCHED_DIM =
    "Lapp/morphe/extension/youtube/patches/eternalhistory/EternalWatchedDim;"
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
            version = "21.16.256",
            minSdk = 28
        ),
        AppTarget(
            version = "21.13.164",
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
 * YouTube's Litho mount helper applies node properties such as content description and alpha.
 * Matching the platform View calls rather than an obfuscated class/method name keeps the hook
 * resilient across the supported app versions.
 */
private object LithoMountPropertiesFingerprint : Fingerprint(
    accessFlags = listOf(AccessFlags.STATIC),
    returnType = "V",
    filters = listOf(
        methodCall(
            opcode = Opcode.INVOKE_VIRTUAL,
            smali = "Landroid/view/View;->setContentDescription(Ljava/lang/CharSequence;)V"
        ),
        methodCall(
            opcode = Opcode.INVOKE_VIRTUAL,
            smali = "Landroid/view/View;->setAlpha(F)V"
        )
    )
)

/**
 * Adds a conservative pre-filter to Morphe's already-patched Litho filtering entry point.
 * The Worker is never queried per card; the decision uses the local D1 ledger cache only.
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
                invoke-static { p0, p1, p2, p3 }, $WATCHED_FILTER->shouldHide($CONTEXT_INTERFACE[BLjava/lang/String;Ljava/lang/String;)Z
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

/**
 * Connects Eternal's watched-card decision to YouTube's own Litho alpha property instead of
 * directly mutating recycled Views. This matters because Litho's normal unmount path then resets
 * alpha to 1.0, preventing a watched card's opacity from leaking into a reused unwatched card.
 */
context(context: BytecodePatchContext)
private fun installWatchedDimHook() {
    val method = LithoMountPropertiesFingerprint.method
    val instructions = method.implementation?.instructions
        ?: throw PatchException("Eternal dim: Litho mount method has no implementation")

    var alphaIndex = -1
    var viewRegister = -1
    var nodeRegister = -1
    var alphaField: FieldReference? = null

    // Find the View.setAlpha() whose argument is loaded from the Litho node-info float field.
    // Other setAlpha() calls (for animations/resets) are ignored because they are not preceded by
    // an iget of a float from the node-info object.
    for (i in instructions.indices) {
        val instruction = instructions[i]
        val methodRef = (instruction as? ReferenceInstruction)?.reference as? MethodReference ?: continue
        if (
            methodRef.definingClass != "Landroid/view/View;" ||
            methodRef.name != "setAlpha" ||
            methodRef.parameterTypes.size != 1 ||
            methodRef.parameterTypes.first().toString() != "F"
        ) continue

        val invoke = instruction as? FiveRegisterInstruction ?: continue
        for (j in (i - 1) downTo maxOf(0, i - 5)) {
            val fieldInstruction = instructions[j]
            val fieldRef = (fieldInstruction as? ReferenceInstruction)?.reference as? FieldReference ?: continue
            val registers = fieldInstruction as? TwoRegisterInstruction ?: continue
            if (fieldRef.type != "F" || fieldInstruction.opcode != Opcode.IGET) continue

            alphaIndex = i
            viewRegister = invoke.registerC
            nodeRegister = registers.registerB
            alphaField = fieldRef
            break
        }
        if (alphaIndex >= 0) break
    }

    val field = alphaField
        ?: throw PatchException("Eternal dim: Litho node alpha field was not found")
    if (viewRegister < 0 || nodeRegister < 0) {
        throw PatchException("Eternal dim: Litho alpha registers were not found")
    }

    // The alpha-presence boolean getter immediately precedes the branch that guards setAlpha().
    // Insert before it, so setting node alpha also makes the existing guard see the new value.
    var gateIndex = -1
    for (i in (alphaIndex - 1) downTo maxOf(0, alphaIndex - 12)) {
        val ref = (instructions[i] as? ReferenceInstruction)?.reference as? MethodReference ?: continue
        if (
            ref.definingClass == field.definingClass &&
            ref.returnType == "Z" &&
            ref.parameterTypes.isEmpty()
        ) {
            gateIndex = i
            break
        }
    }
    if (gateIndex < 0) throw PatchException("Eternal dim: Litho alpha gate was not found")

    // Resolve the node's own alpha setter by the exact field it writes. This avoids hard-coding
    // an obfuscated method name and avoids reflection on the hot feed-render path.
    val nodeClass = context.mutableClassDefByOrNull(field.definingClass)
        ?: throw PatchException("Eternal dim: Litho node-info class was not found")
    val alphaSetter = nodeClass.methods.firstOrNull { candidate ->
        candidate.returnType == "V" &&
            candidate.parameters.size == 1 &&
            candidate.parameters.first().type == "F" &&
            candidate.implementation?.instructions?.any { setterInstruction ->
                if (setterInstruction.opcode != Opcode.IPUT) return@any false
                val setterField = (setterInstruction as? ReferenceInstruction)?.reference as? FieldReference
                    ?: return@any false
                setterField.definingClass == field.definingClass &&
                    setterField.name == field.name &&
                    setterField.type == field.type
            } == true
    } ?: throw PatchException("Eternal dim: Litho node alpha setter was not found")

    method.apply {
        val free = findFreeRegister(gateIndex, viewRegister, nodeRegister)
        // Standard invoke encodings use 4-bit registers. The current supported YouTube versions
        // all use low registers here; fail closed at patch time if that ever changes.
        if (free > 15 || viewRegister > 15 || nodeRegister > 15) {
            throw PatchException("Eternal dim: Litho mount registers exceed invoke encoding")
        }
        val continueInstruction = getInstruction(gateIndex)
        addInstructionsWithLabels(
            gateIndex,
            """
                invoke-static { v$viewRegister }, $WATCHED_DIM->shouldDim(Landroid/view/View;)Z
                move-result v$free
                if-eqz v$free, :eternal_dim_continue
                const v$free, 0x3ec28f5c
                invoke-virtual { v$nodeRegister, v$free }, ${field.definingClass}->${alphaSetter.name}(F)V
            """.trimIndent(),
            ExternalLabel("eternal_dim_continue", continueInstruction)
        )
    }
}

private val eternalHistoryBytecodePatch = bytecodePatch {
    extendWith("extensions/extension.mpe")
    finalize {
        registerAddOn(REGISTER_METHOD)
        installWatchedCardHook()
        installWatchedDimHook()
    }
}

private val eternalHistoryResourcePatch = resourcePatch {
    execute { addEternalResources() }
}

@Suppress("unused")
val eternalHistoryPatch = bytecodePatch(
    name = "Eternal YouTube History",
    description = "Writes Android YouTube watch/progress directly to your private Eternal D1 ledger and can dim or hide watched feed cards from the local cache.",
    default = false
) {
    compatibleWith(YOUTUBE)
    dependsOn(eternalHistoryResourcePatch, eternalHistoryBytecodePatch)
    execute { }
}
