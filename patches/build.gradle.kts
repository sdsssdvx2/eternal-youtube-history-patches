group = "app.eternal"

patches {
    about {
        name = "Eternal YouTube History Patches"
        description = "Private D1-backed permanent YouTube watch history add-on for Morphe"
        source = "https://github.com/sdsssdvx2/eternal-youtube-history-patches"
        author = "Eternal YouTube History"
        contact = "na"
        website = "https://github.com/sdsssdvx2/eternal-youtube-history-patches"
        license = "GPLv3"
    }
}

// Gson is required to compile and run PatchListGenerator, but should not be bundled
// into the patched Android app / extension runtime.
val patchListGeneratorClasspath = configurations.create("patchListGeneratorClasspath")

dependencies {
    implementation(libs.morphe.patches.library)
    compileOnly(libs.gson)
    patchListGeneratorClasspath(libs.gson)
}

tasks {
    named("sourcesJar") { enabled = false }
    register<JavaExec>("generatePatchesList") {
        description = "Build patch with patch list"
        dependsOn(build)
        classpath = sourceSets["main"].runtimeClasspath + patchListGeneratorClasspath
        mainClass.set("util.PatchListGeneratorKt")
    }
    publish { dependsOn("generatePatchesList") }
}

kotlin {
    compilerOptions { freeCompilerArgs = listOf("-Xcontext-parameters") }
}
