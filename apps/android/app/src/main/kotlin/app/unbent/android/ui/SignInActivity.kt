package app.unbent.android.ui

import android.net.Uri
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.lifecycle.lifecycleScope
import app.unbent.android.Prefs
import app.unbent.android.R
import app.unbent.android.api.DeviceAuth
import app.unbent.android.api.DeviceCodeGrant
import app.unbent.android.api.SignInResult
import app.unbent.android.databinding.ActivitySignInBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Signs this phone in with the device flow, so no password is ever typed here.
 *
 * The approval page opens in a Custom Tab rather than a WebView on purpose: it reuses
 * Chrome's cookies, so a user already signed in to Unbent on their phone approves with one
 * tap instead of signing in again through an OAuth flow that a WebView would block anyway.
 */
class SignInActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySignInBinding
    private var grant: DeviceCodeGrant? = null
    private var finished = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySignInBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.openButton.isEnabled = false
        binding.status.setText(R.string.sign_in_waiting)

        start()
    }

    private fun start() {
        val prefs = Prefs(this)
        val auth = DeviceAuth(prefs.instance)

        lifecycleScope.launch {
            val requested = withContext(Dispatchers.IO) {
                runCatching { auth.requestCode() }
            }

            val g = requested.getOrElse { e ->
                binding.status.text = e.message ?: getString(R.string.save_failed)
                return@launch
            }

            grant = g
            binding.code.text = g.userCode
            binding.openButton.isEnabled = true
            binding.openButton.setOnClickListener { openApproval(auth, g) }

            // Straight to the browser: the user asked to sign in, and making them tap a
            // second button to get there is a step with no decision in it.
            openApproval(auth, g)

            val result = withContext(Dispatchers.IO) {
                auth.awaitToken(g, isCancelled = { finished || isDestroyed })
            }

            when (result) {
                is SignInResult.Success -> {
                    prefs.token = result.token
                    binding.status.setText(R.string.sign_in_done)
                    finished = true
                    setResult(RESULT_OK)
                    finish()
                }
                is SignInResult.Denied -> binding.status.setText(R.string.sign_in_denied)
                is SignInResult.Expired -> binding.status.setText(R.string.sign_in_expired)
                is SignInResult.Failed -> binding.status.text = result.message
            }
        }
    }

    private fun openApproval(auth: DeviceAuth, g: DeviceCodeGrant) {
        val intent = CustomTabsIntent.Builder().setShowTitle(true).build()
        runCatching { intent.launchUrl(this, Uri.parse(auth.approvalUrl(g))) }
    }

    override fun onDestroy() {
        finished = true
        super.onDestroy()
    }
}
