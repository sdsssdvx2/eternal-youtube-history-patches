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
private val UPDATE_VISIBLE_PACKAGES = arrayOf(
    "app.morphe.android.apps.youtube.music",
    "com.google.android.apps.youtube.music",
)

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

context(context: ResourcePatchContext)
internal fun addEternalResources() {
    // Keep value resource types in their normal Android files. In particular, string-array entries
    // must live in arrays.xml so Morphe's resource table encoder can allocate the array entries.
    appendBundledValues("strings.xml")
    appendBundledValues("arrays.xml")

    // morphe_addon_prefs.xml is a shared declaration file. Append instead of replacing it so this
    // add-on can coexist with other third-party Morphe sources in the same patching run.
    declareAddOnPreferences()

    // Android 11+ hides unrelated installed packages unless they are explicitly queryable. The
    // updater only needs these two narrow Music package names; avoid QUERY_ALL_PACKAGES entirely.
    declareUpdatePackageVisibility()
}
