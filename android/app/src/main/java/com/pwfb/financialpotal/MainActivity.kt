package com.pwfb.financialpotal

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.content.Intent

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var splash: View
    private val portalUrl = "https://pwfb-financial-potal-web.onrender.com"
    private val portalHost = "pwfb-financial-potal-web.onrender.com"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(245, 130, 32)
        window.navigationBarColor = Color.rgb(25, 50, 35)
        window.decorView.systemUiVisibility = 0

        val root = FrameLayout(this)
        root.setBackgroundColor(Color.rgb(255, 248, 239))

        webView = WebView(this)
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal)
        progress.max = 100
        progress.progressTintList = android.content.res.ColorStateList.valueOf(Color.rgb(245, 130, 32))
        root.addView(webView, FrameLayout.LayoutParams(-1, -1))
        root.addView(progress, FrameLayout.LayoutParams(-1, dp(3), Gravity.TOP))

        splash = createSplash()
        root.addView(splash, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)

        // Always fetch the current portal instead of reusing stale WebView cache.
        webView.settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
        webView.clearCache(true)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.databaseEnabled = true
        webView.settings.loadsImagesAutomatically = true
        webView.settings.useWideViewPort = true
        webView.settings.loadWithOverviewMode = true
        webView.settings.javaScriptCanOpenWindowsAutomatically = true
        webView.settings.setSupportMultipleWindows(false)
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress >= 100) View.GONE else View.VISIBLE
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                progress.visibility = View.VISIBLE
            }
            override fun onPageFinished(view: WebView?, url: String?) {
                progress.visibility = View.GONE
                CookieManager.getInstance().flush()
                splash.visibility = View.GONE
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.scheme == "https" && uri.host == portalHost) return false
                if (uri.scheme == "http" || uri.scheme == "https") {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    return true
                }
                return true
            }
        }
        // Do not restore a previous WebView page: it may reopen stale portal code.
        webView.loadUrl("$portalUrl?app_refresh=${System.currentTimeMillis()}")
    }

    private fun createSplash(): View {
        val background = LinearLayout(this)
        background.orientation = LinearLayout.VERTICAL
        background.gravity = Gravity.CENTER
        background.setPadding(dp(28), dp(28), dp(28), dp(28))
        background.setBackgroundColor(Color.rgb(255, 248, 239))

        val accent = View(this)
        accent.background = GradientDrawable(
            GradientDrawable.Orientation.LEFT_RIGHT,
            intArrayOf(Color.rgb(245, 130, 32), Color.rgb(255, 183, 77))
        ).apply { cornerRadius = dp(4).toFloat() }
        val accentParams = LinearLayout.LayoutParams(dp(74), dp(6))
        accentParams.bottomMargin = dp(30)
        background.addView(accent, accentParams)

        val logo = TextView(this)
        logo.text = "P"
        logo.gravity = Gravity.CENTER
        logo.textSize = 46f
        logo.setTextColor(Color.WHITE)
        logo.typeface = Typeface.create("sans-serif-black", Typeface.BOLD)
        logo.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.rgb(25, 50, 35))
            setStroke(dp(5), Color.rgb(245, 130, 32))
        }
        background.addView(logo, LinearLayout.LayoutParams(dp(112), dp(112)))

        val title = TextView(this)
        title.text = "PWFB"
        title.textSize = 30f
        title.letterSpacing = 0.12f
        title.typeface = Typeface.create("sans-serif", Typeface.BOLD)
        title.setTextColor(Color.rgb(25, 50, 35))
        title.gravity = Gravity.CENTER
        val titleParams = LinearLayout.LayoutParams(-2, -2)
        titleParams.topMargin = dp(22)
        background.addView(title, titleParams)

        val subtitle = TextView(this)
        subtitle.text = "FINANCIAL POTAL"
        subtitle.textSize = 14f
        subtitle.letterSpacing = 0.16f
        subtitle.typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
        subtitle.setTextColor(Color.rgb(245, 130, 32))
        subtitle.gravity = Gravity.CENTER
        val subtitleParams = LinearLayout.LayoutParams(-2, -2)
        subtitleParams.topMargin = dp(5)
        background.addView(subtitle, subtitleParams)

        val tagline = TextView(this)
        tagline.text = "Your finances. Clearly connected."
        tagline.textSize = 14f
        tagline.setTextColor(Color.rgb(92, 99, 89))
        tagline.gravity = Gravity.CENTER
        val taglineParams = LinearLayout.LayoutParams(-1, -2)
        taglineParams.topMargin = dp(14)
        background.addView(tagline, taglineParams)

        val spinner = ProgressBar(this)
        spinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.rgb(245, 130, 32))
        val spinnerParams = LinearLayout.LayoutParams(dp(34), dp(34))
        spinnerParams.topMargin = dp(34)
        background.addView(spinner, spinnerParams)

        val loading = TextView(this)
        loading.text = "Loading your workspace…"
        loading.textSize = 12f
        loading.setTextColor(Color.rgb(92, 99, 89))
        loading.gravity = Gravity.CENTER
        val loadingParams = LinearLayout.LayoutParams(-1, -2)
        loadingParams.topMargin = dp(10)
        background.addView(loading, loadingParams)

        return background
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("Deprecated in Android API")
    override fun onBackPressed() {
        if (this::webView.isInitialized && webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
