import com.android.build.api.dsl.ApplicationExtension

extension {
    name = "extensions/extension.mpe"
}

// Compile against the official Morphe extension classes checked out next to this repository.
val baseExtDir = rootProject.file("../morphe-patches/extensions")
val baseClassesStaging = layout.buildDirectory.dir("base-classes-staging")

val stageBaseClasses = tasks.register<Sync>("stageBaseClasses") {
    description = "Stages official Morphe extension classes for compileOnly use."
    val libJars = fileTree(baseExtDir) {
        include("**/build/intermediates/compile_library_classes_jar/release/**/*.jar")
        include("**/build/intermediates/aar_main_jar/release/**/*.jar")
        include("**/build/intermediates/**/bundleLibCompileToJarRelease/**/*.jar")
    }
    libJars.forEach { from(zipTree(it)) }
    listOf(
        "youtube/build/intermediates/javac/release/compileReleaseJavaWithJavac/classes",
        "youtube/build/intermediates/built_in_kotlinc/release/compileReleaseKotlin/classes"
    ).forEach { from("$baseExtDir/$it") }
    into(baseClassesStaging)
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
}

dependencies {
    testImplementation(libs.junit)
    compileOnly(libs.annotation)
    compileOnly(libs.morphe.extensions.library)
}

val baseClassesFiles = files(baseClassesStaging).builtBy(stageBaseClasses)
afterEvaluate {
    tasks.matching { it.name.startsWith("compile") && it.name.endsWith("JavaWithJavac") }.configureEach {
        val jc = this as JavaCompile
        jc.classpath = (jc.classpath ?: files()) + baseClassesFiles
    }
    tasks.matching { it.name.startsWith("compile") && it.name.endsWith("Kotlin") }.configureEach {
        (this as org.jetbrains.kotlin.gradle.tasks.KotlinCompile).libraries.from(baseClassesFiles)
    }
}

configure<ApplicationExtension> {
    namespace = "app.eternal.extension"
    defaultConfig { minSdk = 26 }
}
