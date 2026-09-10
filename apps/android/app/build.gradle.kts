import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.kotlin.compose)
}

/**
 * Release signing, read from `local.properties` or the environment.
 *
 * Kept out of the repo entirely: the keystore is the identity the Digital Asset Links file
 * on unbent.app vouches for, and losing control of it means someone else can publish an app
 * that claims to be Unbent. When the properties are absent — a fresh clone, or CI without
 * the secret — the release build simply has no signing config and `assembleDebug` still
 * works, which is better than failing the whole build for the common case.
 */
val keystoreProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

fun secret(key: String, env: String): String? =
    keystoreProps.getProperty(key) ?: System.getenv(env)

val releaseStorePath = secret("unbent.keystore.path", "UNBENT_KEYSTORE_PATH")

android {
    /**
     * The Kotlin package, which moved here from `app.unbent.android` when the app was
     * prepared for the Play Store.
     *
     * It is kept equal to `applicationId` below rather than left where it was. The two are
     * independent as far as Gradle is concerned — only the id reaches Play, App Links and
     * OAuth — but a source tree whose package disagrees with the installed id is a trap for
     * anyone reading a stack trace or writing an `adb shell am` command, and there is
     * nothing else in the tree that would explain the split.
     */
    namespace = "com.makerocketgonow.unbent"
    /**
     * What the app is compiled against, which is not what it promises to behave like —
     * that is `targetSdk` below. Raising this only lets the compiler see newer APIs.
     *
     * It moved because AndroidX and Material now ship AARs whose metadata demands 37, and
     * Gradle refuses them outright at `CheckAarMetadataWorkAction` rather than degrading —
     * so this is the floor for taking any of those updates at all.
     */
    compileSdk = 37

    defaultConfig {
        /**
         * The identity Play, the Digital Asset Links file on unbent.app and the Google
         * OAuth client all key on — and the one string here that can never change again
         * once the app is published, since Play treats a different id as a different app
         * with no upgrade path for anyone who installed the old one.
         *
         * `app.unbent.android` was never published, so this rename is free. It is
         * `com.makerocketgonow.*` because that is the domain the developer account is
         * registered under, and a reverse-domain id has to be one the publisher controls.
         */
        applicationId = "com.makerocketgonow.unbent"
        minSdk = 26
        /**
         * The behaviours the app opts into, which is the half that actually changes at
         * runtime. It moved to 36 because Play stopped accepting 35 for new installs on
         * Android 16 devices as of 31 August 2026 — an update still reaches existing
         * users, but nobody new on a current phone can install it.
         *
         * What 36 enforces, and why none of it needed code: edge-to-edge can no longer be
         * opted out of, and every activity already calls `enableEdgeToEdge()` with insets
         * handled per screen; orientation and resizability locks are ignored above 600dp,
         * and none are declared; `onBackPressed` stops being called, and back is handled
         * through Compose's `BackHandler` rather than the removed path.
         */
        targetSdk = 36
        /**
         * Play rejects an upload whose code it has seen before, and it is the ordering
         * Android itself uses to decide what counts as an upgrade — so this has to rise on
         * every build that could reach the store, and a number nobody has to remember to
         * bump is the only version of that which survives contact with a busy week.
         *
         * CI passes the run number, which only ever increases and is unique across the
         * repository. A local build falls back to 1: nothing built by hand goes to Play,
         * and a fixed number there keeps `assembleDebug` reproducible.
         */
        versionCode = secret("unbent.versionCode", "UNBENT_VERSION_CODE")?.toIntOrNull() ?: 1
        // What a person sees, in Settings and on the store listing. Bumped by hand, because
        // it means something — unlike the code above, which is bookkeeping.
        versionName = "0.1.1"

        // The site the app is a shell for. Overridable at runtime in Settings, which is
        // what makes an emulator build usable against a local dev server.
        buildConfigField("String", "DEFAULT_INSTANCE", "\"https://unbent.app\"")
        buildConfigField("String", "CONNECT_SCHEME", "\"unbent\"")
        // Google issues the ID token for the *web* client, which is the audience the
        // API already verifies. The Android client exists only so Google will trust a
        // request coming from this app's signature. Empty disables the native picker.
        buildConfigField(
            "String",
            "GOOGLE_WEB_CLIENT_ID",
            "\"${secret("unbent.google.webClientId", "UNBENT_GOOGLE_WEB_CLIENT_ID") ?: ""}\"",
        )
        manifestPlaceholders["connectScheme"] = "unbent"
    }

    signingConfigs {
        if (releaseStorePath != null) {
            create("release") {
                storeFile = file(releaseStorePath)
                storePassword = secret("unbent.keystore.password", "UNBENT_KEYSTORE_PASSWORD")
                keyAlias = secret("unbent.key.alias", "UNBENT_KEY_ALIAS") ?: "unbent"
                keyPassword = secret("unbent.key.password", "UNBENT_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            // A separate id so a debug build can sit beside a release install, each with
            // its own share-sheet entry and its own stored token.
            applicationIdSuffix = ".debug"
            /*
             * And a separate name, because the two are otherwise indistinguishable. Two
             * identical icons in the launcher, and two identical entries in every share
             * sheet, is a coin flip over which install — and which stored session — the
             * thing you just shared went to.
             */
            resValue("string", "app_name", "Unbent (debug)")
            buildConfigField("String", "CONNECT_SCHEME", "\"unbent-debug\"")
            manifestPlaceholders["connectScheme"] = "unbent-debug"
            // Lets a debug build talk to http://10.0.2.2:5173 from the emulator.
            // Release stays cleartext-free; see network_security_config.xml.
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            manifestPlaceholders["usesCleartextTraffic"] = "false"
            if (releaseStorePath != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
        // AGP 9 turns this off by default. The debug build type renames the app via
        // `resValue`, so it has to be asked for explicitly now.
        resValues = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "META-INF/AL2.0", "META-INF/LGPL2.1")
    }
}

// AGP 9 compiles Kotlin itself, so `kotlinOptions` inside `android { }` is gone. The JVM
// target still has to be stated, and still has to match `compileOptions` above — a mismatch
// is a hard error, not a warning.
kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.core)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.lifecycle.runtime.compose)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services)
    implementation(libs.googleid)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
}
