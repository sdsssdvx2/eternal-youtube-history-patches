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
import com.android.tools.smali.dexlib2.iface.instruction.OneRegisterInstruction
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
 * We use it only as an obfuscation-safe structural anchor to discover NodeInfo's alpha field and
 * setter. Eternal no longer executes any code from the hot View mount path.
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
 * This is the same create-component method Morphe's Litho filter patches. The two diagnostic
 * strings have remained the stable anchor while the surrounding YouTube classes are obfuscated.
 */
private object LithoCreateComponentFingerprint : Fingerprint(
    returnType = "L",
    strings = listOf(
        "Element missing correct type extension",
        "Element missing type"
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
 * Resolves Litho's NodeInfo alpha setter from the actual mount implementation. This is patch-time
 * discovery only; no Eternal code is executed for every mounted View.
 */
context(context: BytecodePatchContext)
private fun resolveLithoAlphaSetter(): Pair<FieldReference, MethodReference> {
    val mountMethod = LithoMountPropertiesFingerprint.method
    val instructions = mountMethod.implementation?.instructions
        ?: throw PatchException("Eternal dim: Litho mount method has no implementation")

    var alphaField: FieldReference? = null

    // Find the View.setAlpha() whose argument is loaded from a float field on Litho NodeInfo.
    for (i in instructions.indices) {
        val instruction = instructions[i]
        val methodRef = (instruction as? ReferenceInstruction)?.reference as? MethodReference ?: continue
        if (
            methodRef.definingClass != "Landroid/view/View;" ||
            methodRef.name != "setAlpha" ||
            methodRef.parameterTypes.size != 1 ||
            methodRef.parameterTypes.first().toString() != "F"
        ) continue

        for (j in (i - 1) downTo maxOf(0, i - 5)) {
            val fieldInstruction = instructions[j]
            val fieldRef = (fieldInstruction as? ReferenceInstruction)?.reference as? FieldReference ?: continue
            if (fieldRef.type != "F" || fieldInstruction.opcode != Opcode.IGET) continue
            if (fieldInstruction !is TwoRegisterInstruction) continue
            alphaField = fieldRef
            break
        }
        if (alphaField != null) break
    }

    val field = alphaField
        ?: throw PatchException("Eternal dim: Litho node alpha field was not found")
    val nodeClass = context.mutableClassDefByOrNull(field.definingClass)
        ?: throw PatchException("Eternal dim: Litho node-info class was not found")

    val alphaSetter = nodeClass.methods.firstOrNull { candidate ->
        !AccessFlags.STATIC.isSet(candidate.accessFlags) &&
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

    return field to alphaSetter
}

/**
 * Applies dimming to the exact component that Eternal just classified as watched.
 *
 * Morphe invokes its extension filter immediately before returning this component. Eternal stores
 * only a per-layout-thread boolean for that tiny hand-off. We consume it at the original return,
 * then write alpha through the component's own CommonProps -> NodeInfo path. This completely
 * removes the old global FIFO, accessibility/contentDescription matching and mount-order guesses.
 *
 * The CommonProps byte flag is also set exactly like Litho's normal builder alpha method. This is
 * important because it tells Litho that this component carries a view-affecting common property,
 * allowing the whole card to receive the alpha rather than relying on a random child mount node.
 */
context(context: BytecodePatchContext)
private fun installWatchedDimHook() {
    val (alphaField, alphaSetter) = resolveLithoAlphaSetter()
    val nodeInfoType = alphaField.definingClass

    val createMethod = LithoCreateComponentFingerprint.method
    val createInstructions = createMethod.implementation?.instructions
        ?: throw PatchException("Eternal dim: create-component method has no implementation")
    val returnIndex = createInstructions.indexOfLast { it.opcode == Opcode.RETURN_OBJECT }
    if (returnIndex < 0) throw PatchException("Eternal dim: component return was not found")

    val componentRegister =
        (createInstructions[returnIndex] as? OneRegisterInstruction)?.registerA
            ?: throw PatchException("Eternal dim: component return register was not found")
    val componentType = createMethod.returnType
    if (!componentType.startsWith("L")) {
        throw PatchException("Eternal dim: unexpected component return type $componentType")
    }

    val componentClass = context.mutableClassDefByOrNull(componentType)
        ?: throw PatchException("Eternal dim: component class was not found")

    // The CommonProps type is the component field whose class owns both a NodeInfo field and the
    // byte property-mask field. On 21.16.256 this resolves gec -> gdy without hard-coded names.
    val commonPropsTypes = componentClass.fields.map { it.type }.distinct().filter { candidateType ->
        if (!candidateType.startsWith("L")) return@filter false
        val candidateClass = context.mutableClassDefByOrNull(candidateType) ?: return@filter false
        candidateClass.fields.any { it.type == nodeInfoType } &&
            candidateClass.fields.any { it.type == "B" }
    }
    if (commonPropsTypes.size != 1) {
        throw PatchException("Eternal dim: expected one CommonProps type, found ${commonPropsTypes.size}")
    }
    val commonPropsType = commonPropsTypes.single()
    val commonPropsClass = context.mutableClassDefByOrNull(commonPropsType)
        ?: throw PatchException("Eternal dim: CommonProps class was not found")

    val commonPropsAccessor = componentClass.methods.singleOrNull { candidate ->
        !AccessFlags.STATIC.isSet(candidate.accessFlags) &&
            candidate.parameters.isEmpty() &&
            candidate.returnType == commonPropsType
    } ?: throw PatchException("Eternal dim: CommonProps accessor was not uniquely found")

    val nodeInfoAccessor = commonPropsClass.methods.singleOrNull { candidate ->
        !AccessFlags.STATIC.isSet(candidate.accessFlags) &&
            candidate.parameters.isEmpty() &&
            candidate.returnType == nodeInfoType
    } ?: throw PatchException("Eternal dim: NodeInfo accessor was not uniquely found")

    val commonPropsFlag = commonPropsClass.fields.singleOrNull { it.type == "B" }
        ?: throw PatchException("Eternal dim: CommonProps property-mask byte was not uniquely found")
    val commonPropsFlagRef =
        "${commonPropsFlag.definingClass}->${commonPropsFlag.name}:${commonPropsFlag.type}"

    createMethod.apply {
        val decisionRegister = findFreeRegister(returnIndex, componentRegister)
        val commonPropsRegister = findFreeRegister(returnIndex, componentRegister, decisionRegister)
        val nodeInfoRegister = findFreeRegister(
            returnIndex, componentRegister, decisionRegister, commonPropsRegister
        )
        val alphaRegister = findFreeRegister(
            returnIndex, componentRegister, decisionRegister, commonPropsRegister, nodeInfoRegister
        )

        // The compact invoke encoding needs 4-bit registers. Fail at patch time rather than emit an
        // invalid APK if a future YouTube build changes this method's register layout substantially.
        val registers = listOf(
            decisionRegister, commonPropsRegister, nodeInfoRegister, alphaRegister, componentRegister
        )
        if (registers.any { it > 15 }) {
            throw PatchException("Eternal dim: component registers exceed invoke encoding")
        }

        val originalReturn = getInstruction(returnIndex)
        addInstructionsWithLabels(
            returnIndex,
            """
                invoke-static {}, $WATCHED_DIM->consumePreparedDim()Z
                move-result v$decisionRegister
                if-eqz v$decisionRegister, :eternal_dim_component_continue
                if-eqz v$componentRegister, :eternal_dim_component_continue

                invoke-virtual { v$componentRegister }, $componentType->${commonPropsAccessor.name}()$commonPropsType
                move-result-object v$commonPropsRegister
                invoke-virtual { v$commonPropsRegister }, $commonPropsType->${nodeInfoAccessor.name}()$nodeInfoType
                move-result-object v$nodeInfoRegister

                const v$alphaRegister, 0x3ec28f5c
                invoke-virtual { v$nodeInfoRegister, v$alphaRegister }, $nodeInfoType->${alphaSetter.name}(F)V

                iget-byte v$decisionRegister, v$commonPropsRegister, $commonPropsFlagRef
                or-int/lit8 v$decisionRegister, v$decisionRegister, 0x8
                int-to-byte v$decisionRegister, v$decisionRegister
                iput-byte v$decisionRegister, v$commonPropsRegister, $commonPropsFlagRef
            """.trimIndent(),
            ExternalLabel("eternal_dim_component_continue", originalReturn)
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
