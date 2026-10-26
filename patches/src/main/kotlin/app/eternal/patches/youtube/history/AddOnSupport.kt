package app.eternal.patches.youtube.history

import app.morphe.patcher.Fingerprint
import app.morphe.patcher.InstructionLocation.MatchAfterImmediately
import app.morphe.patcher.InstructionLocation.MatchAfterWithin
import app.morphe.patcher.extensions.InstructionExtensions.addInstruction
import app.morphe.patcher.extensions.InstructionExtensions.getInstruction
import app.morphe.patcher.fieldAccess
import app.morphe.patcher.literal
import app.morphe.patcher.methodCall
import app.morphe.patcher.opcode
import app.morphe.patcher.patch.BytecodePatchContext
import app.morphe.patcher.patch.PatchException
import app.morphe.patcher.patch.ResourcePatchContext
import app.morphe.patcher.resource.ResourceType
import app.morphe.patcher.resourceLiteral
import app.morphe.patcher.string
import app.morphe.util.addInstructionsAtControlFlowLabel
import app.morphe.util.forEachChildElement
import app.morphe.util.getNode
import app.morphe.util.inputStreamFromBundledResource
import com.android.tools.smali.dexlib2.AccessFlags
import com.android.tools.smali.dexlib2.Opcode
import com.android.tools.smali.dexlib2.iface.instruction.OneRegisterInstruction
import com.android.tools.smali.dexlib2.iface.instruction.ReferenceInstruction
import com.android.tools.smali.dexlib2.iface.reference.MethodReference

private const val ADD_ON_MANAGER_CLASS_DESCRIPTOR = "Lapp/morphe/extension/youtube/addon/AddOnManager;"
private const val ADD_ON_MANAGER_REGISTER_METHOD_NAME = "registerAddOns"
private const val ADD_ON_PREFERENCES_FILE_PATH = "morphe_addon_prefs.xml"
private const val UPDATER_PERMISSION = "app.morphe.android.youtube.permission.ETERNAL_UPDATER_CONFIG"
private const val UPDATER_PROVIDER_CLASS =
    "app.morphe.extension.youtube.patches.eternalhistory.EternalUpdaterConfigProvider"
private const val UPDATER_PROVIDER_AUTHORITY = "app.morphe.android.youtube.eternal.updaterconfig"
private const val WATCH_LATER_JOB_SERVICE_CLASS =
    "app.morphe.extension.youtube.patches.eternalhistory.EternalWatchLaterJobService"
private const val ETERNAL_TOOLBAR_CLASS =
    "Lapp/morphe/extension/youtube/patches/eternalhistory/EternalHistoryToolbar;"
private const val ETERNAL_SURFACE_TRACKER_CLASS =
    "Lapp/morphe/extension/youtube/patches/eternalhistory/EternalSurfaceTracker;"
private val UPDATE_VISIBLE_PACKAGES = arrayOf(
    "app.morphe.android.apps.youtube.music",
    "com.google.android.apps.youtube.music",
)

/**
 * Mirrors Morphe's current toolbar fingerprint but calls Eternal directly. Keeping this independent
 * avoids assuming that another optional Morphe toolbar patch happened to be enabled.
 */
private object EternalToolbarButtonFingerprint : Fingerprint(
    accessFlags = listOf(AccessFlags.PUBLIC, AccessFlags.FINAL),
    returnType = "V",
    filters = listOf(
        resourceLiteral(ResourceType.ID, "menu_item_view"),
        methodCall(smali = "Landroid/view/MenuItem;->setShowAsAction(I)V"),
        methodCall(
            opcode = Opcode.INVOKE_STATIC,
            returnType = "L",
            parameters = listOf("I")
        ),
        opcode(Opcode.MOVE_RESULT_OBJECT, MatchAfterImmediately()),
        methodCall(
            opcode = Opcode.INVOKE_INTERFACE,
            returnType = "I",
            parameters = listOf("L")
        ),
        opcode(Opcode.MOVE_RESULT, MatchAfterImmediately()),
        fieldAccess(
            opcode = Opcode.IGET_OBJECT,
            type = "Landroid/widget/ImageView;",
            location = MatchAfterWithin(6)
        ),
        methodCall(
            definingClass = "Landroid/content/res/Resources;",
            name = "getDrawable",
            location = MatchAfterWithin(8)
        ),
        methodCall(
            definingClass = "Landroid/widget/ImageView;",
            name = "setImageDrawable",
            location = MatchAfterWithin(4)
        )
    )
)

/**
 * Same structural browse-id anchor used by Morphe's Change start page patch. Eternal only observes
 * the value; it never rewrites it. This makes Watch Later/Liked/playlist/channel/history profiles
 * exact instead of guessing from whichever navigation button is still selected underneath.
 */
private object EternalBrowseIdFingerprint : Fingerprint(
    returnType = "L",
    filters = listOf(
        string("FEwhat_to_watch"),
        literal(512),
        fieldAccess(opcode = Opcode.IPUT_OBJECT, type = "Ljava/lang/String;")
    )
)

context(context: BytecodePatchContext)
private fun installEternalToolbarHook() {
    EternalToolbarButtonFingerprint.apply {
        val mutableMethod = method
        val alreadyInstalled = mutableMethod.implementation?.instructions?.any { instruction ->
            val ref = (instruction as? ReferenceInstruction)?.reference as? MethodReference
            ref?.definingClass == ETERNAL_TOOLBAR_CLASS && ref.name == "onToolbarImageView"
        } == true
        if (alreadyInstalled) return

        val imageViewIndex = instructionMatches[6].index
        val imageViewRegister = mutableMethod
            .getInstruction<OneRegisterInstruction>(imageViewIndex).registerA
        mutableMethod.addInstructionsAtControlFlowLabel(
            imageViewIndex + 1,
            "invoke-static { v$imageViewRegister }, $ETERNAL_TOOLBAR_CLASS->onToolbarImageView(Landroid/widget/ImageView;)V"
        )
    }
}

context(context: BytecodePatchContext)
private fun installEternalBrowseIdHook() {
    EternalBrowseIdFingerprint.apply {
        val mutableMethod = method
        val alreadyInstalled = mutableMethod.implementation?.instructions?.any { instruction ->
            val ref = (instruction as? ReferenceInstruction)?.reference as? MethodReference
            ref?.definingClass == ETERNAL_SURFACE_TRACKER_CLASS && ref.name == "onBrowseId"
        } == true
        if (alreadyInstalled) return

        val browseIdIndex = instructionMatches.first().index
        val browseIdRegister = mutableMethod
            .getInstruction<OneRegisterInstruction>(browseIdIndex).registerA
        mutableMethod.addInstruction(
            browseIdIndex + 1,
            "invoke-static { v$browseIdRegister }, $ETERNAL_SURFACE_TRACKER_CLASS->onBrowseId(Ljava/lang/String;)V"
        )
    }
}

context(context: BytecodePatchContext)
internal fun registerAddOn(registrationMethodDescriptor: String) {
    val manager = context.mutableClassDefByOrNull(ADD_ON_MANAGER_CLASS_DESCRIPTOR)
        ?: throw PatchException("Eternal History requires Morphe official add-on support")
    val method = manager.methods.firstOrNull {
        it.name == ADD_ON_MANAGER_REGISTER_METHOD_NAME && it.returnType == "V" &&
            it.parameters.isEmpty() && AccessFlags.PUBLIC.isSet(it.accessFlags) && AccessFlags.STATIC.isSet(it.accessFlags)
    } ?: throw PatchException("Eternal History could not find AddOnManager.registerAddOns()")
    method.addInstruction(0, "invoke-static { }, $registrationMethodDescriptor")
    installEternalBrowseIdHook()
    installEternalToolbarHook()
}

context(context: ResourcePatchContext)
private fun appendBundledValues(resourceName: String) {
    val source = inputStreamFromBundledResource("addresources", "values/youtube/$resourceName")
        ?: throw PatchException("Eternal History resource is missing: $resourceName")
    val destinationPath = "res/values/$resourceName"
    val destination = context[destinationPath]
    if (!destination.exists()) {
        destination.parentFile?.mkdirs()
        destination.writeText("<?xml version=\"1.0\" encoding=\"utf-8\"?><resources></resources>")
    }

    source.use { stream ->
        context.document(destinationPath).use { dst ->
            val root = dst.getNode("resources")
            val existing = HashSet<String>()
            root.forEachChildElement { node ->
                val name = node.attributes?.getNamedItem("name")?.nodeValue
                if (!name.isNullOrBlank()) existing.add("${node.nodeName}:$name")
            }
            context.document(stream).use { src ->
                src.getNode("resources").forEachChildElement { node ->
                    val name = node.attributes?.getNamedItem("name")?.nodeValue
                    val key = if (name.isNullOrBlank()) null else "${node.nodeName}:$name"
                    if (key == null || existing.add(key)) {
                        root.appendChild(dst.importNode(node, true))
                    }
                }
            }
        }
    }
}

context(context: ResourcePatchContext)
private fun declareAddOnPreferences() {
    val source = inputStreamFromBundledResource("addresources", "youtube/addon_prefs.xml")
        ?: throw PatchException("Eternal History add-on preferences are missing")

    val declarationFile = context[ADD_ON_PREFERENCES_FILE_PATH]
    if (!declarationFile.exists()) {
        declarationFile.parentFile?.mkdirs()
        declarationFile.writeText(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
                "<morphe-add-on-preferences xmlns:android=\"http://schemas.android.com/apk/res/android\"/>"
        )
    }

    source.use { stream ->
        context.document(ADD_ON_PREFERENCES_FILE_PATH).use { dst ->
            val root = dst.getNode("morphe-add-on-preferences")
            context.document(stream).use { src ->
                src.getNode("morphe-add-on-preferences").forEachChildElement { screen ->
                    root.appendChild(dst.importNode(screen, true))
                }
            }
        }
    }
}

context(context: ResourcePatchContext)
private fun declareUpdatePackageVisibility() {
    context.document("AndroidManifest.xml").use { document ->
        val manifest = document.getNode("manifest")
        val existingQueries = document.getElementsByTagName("queries").item(0)
        val queries = existingQueries ?: document.createElement("queries").also(manifest::appendChild)

        val visible = HashSet<String>()
        val packageNodes = document.getElementsByTagName("package")
        for (index in 0 until packageNodes.length) {
            packageNodes.item(index).attributes?.getNamedItem("android:name")?.nodeValue?.let(visible::add)
        }

        UPDATE_VISIBLE_PACKAGES.forEach { packageName ->
            if (visible.add(packageName)) {
                document.createElement("package").also { node ->
                    node.setAttribute("android:name", packageName)
                    queries.appendChild(node)
                }
            }
        }
    }
}

/**
 * The extension manifest belongs to the extension build itself and is not automatically merged
 * into the patched YouTube host manifest. Declare the secure updater bridge explicitly in the
 * target APK so the separately installed Eternal Updater can resolve and call it.
 */
context(context: ResourcePatchContext)
private fun declareUpdaterBridge() {
    context.document("AndroidManifest.xml").use { document ->
        val manifest = document.getNode("manifest")
        val application = document.getElementsByTagName("application").item(0)
            ?: throw PatchException("Eternal History could not find the YouTube application manifest node")

        var permissionPresent = false
        val permissions = document.getElementsByTagName("permission")
        for (index in 0 until permissions.length) {
            val node = permissions.item(index)
            if (node.attributes?.getNamedItem("android:name")?.nodeValue == UPDATER_PERMISSION) {
                permissionPresent = true
                break
            }
        }
        if (!permissionPresent) {
            document.createElement("permission").also { node ->
                node.setAttribute("android:name", UPDATER_PERMISSION)
                node.setAttribute("android:protectionLevel", "signature")
                manifest.insertBefore(node, application)
            }
        }

        var providerPresent = false
        val providers = document.getElementsByTagName("provider")
        for (index in 0 until providers.length) {
            val node = providers.item(index)
            if (node.attributes?.getNamedItem("android:authorities")?.nodeValue == UPDATER_PROVIDER_AUTHORITY) {
                providerPresent = true
                break
            }
        }
        if (!providerPresent) {
            document.createElement("provider").also { node ->
                node.setAttribute("android:name", UPDATER_PROVIDER_CLASS)
                node.setAttribute("android:authorities", UPDATER_PROVIDER_AUTHORITY)
                node.setAttribute("android:exported", "true")
                node.setAttribute("android:readPermission", UPDATER_PERMISSION)
                application.appendChild(node)
            }
        }
    }
}

/** Declare the opt-in low-frequency JobService used for device-side Watch Later cleanup. */
context(context: ResourcePatchContext)
private fun declareWatchLaterJobService() {
    context.document("AndroidManifest.xml").use { document ->
        val application = document.getElementsByTagName("application").item(0)
            ?: throw PatchException("Eternal History could not find the YouTube application manifest node")
        val services = document.getElementsByTagName("service")
        for (index in 0 until services.length) {
            if (services.item(index).attributes?.getNamedItem("android:name")?.nodeValue == WATCH_LATER_JOB_SERVICE_CLASS) {
                return
            }
        }
        document.createElement("service").also { node ->
            node.setAttribute("android:name", WATCH_LATER_JOB_SERVICE_CLASS)
            node.setAttribute("android:permission", "android.permission.BIND_JOB_SERVICE")
            node.setAttribute("android:exported", "false")
            application.appendChild(node)
        }
    }
}

context(context: ResourcePatchContext)
internal fun addEternalResources() {
    appendBundledValues("strings.xml")
    appendBundledValues("arrays.xml")
    declareAddOnPreferences()
    declareUpdatePackageVisibility()
    declareUpdaterBridge()
    declareWatchLaterJobService()
}
