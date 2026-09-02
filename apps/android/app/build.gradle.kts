import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
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
    namespace = "app.unbent.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.unbent.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

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
        viewBinding = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets["main"].java.srcDirs("src/main/kotlin")
    sourceSets["test"].java.srcDirs("src/test/kotlin")

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

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.browser)
    implementation(libs.twa.helper)
    implementation(libs.androidx.work.runtime.ktx)
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
