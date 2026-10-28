plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

val dashboardEnvironment = providers.gradleProperty("energridEnvironment").orElse("home").get()
val homeDashboardUrl = providers.gradleProperty("energridHomeUrl")
    .orElse("https://portal.energrid.bg/d/home").get()
val labDashboardUrl = providers.gradleProperty("energridLabUrl").orElse("").get()
val dashboardUrl = when (dashboardEnvironment) {
    "home" -> homeDashboardUrl
    "lab" -> labDashboardUrl.takeIf(String::isNotBlank)
        ?: throw GradleException("Set -PenergridLabUrl=https://<lab-host>/d/home when using -PenergridEnvironment=lab")
    else -> throw GradleException("energridEnvironment must be home or lab")
}
val cleartextDashboard = dashboardUrl.startsWith("http://", ignoreCase = true)
fun buildConfigString(value: String) = "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

android {
    namespace = "bg.energrid.home"
    compileSdk {
        version = release(36)
    }

    defaultConfig {
        applicationId = "bg.energrid.home"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        buildConfigField("String", "DASHBOARD_ENVIRONMENT", buildConfigString(dashboardEnvironment))
        buildConfigField("String", "DASHBOARD_URL", buildConfigString(dashboardUrl))
        manifestPlaceholders["allowCleartextTraffic"] = cleartextDashboard

        ndk {
            abiFilters += "arm64-v8a"
        }

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
    androidResources {
        ignoreAssetsPatterns += setOf(
            "!alexa_v0.1.onnx",
            "!hey_jarvis_v0.1.onnx",
            "!hey_mycroft_v0.1.onnx",
        )
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.constraintlayout)
    implementation("com.github.msnilsen:openwakeword-android:0.1.0")
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
