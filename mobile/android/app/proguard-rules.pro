# JSE — ProGuard/R8 rules (minifyEnabled is false; kept for completeness)
# Capacitor plugins are reflected by class name:
-keep public class * extends com.getcapacitor.Plugin { *; }
-keep class kr.scoresnap.app.** { *; }
-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }
