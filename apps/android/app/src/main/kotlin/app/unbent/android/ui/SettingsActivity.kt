package app.unbent.android.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.lifecycle.lifecycleScope
import app.unbent.android.Prefs
import app.unbent.android.R
import app.unbent.android.databinding.ActivitySettingsBinding
import kotlinx.coroutines.launch

/**
 * Which Unbent this phone talks to, and whether it is signed in.
 *
 * The address field is not decoration: an emulator reaches a dev server at
 * http://10.0.2.2:5173, and without somewhere to type that the app can only ever be tested
 * against production.
 */
class SettingsActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySettingsBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val prefs = Prefs(this)
        binding.instance.setText(prefs.instance)

        binding.saveButton.setOnClickListener {
            val normalized = Prefs.normalizeOrigin(binding.instance.text.toString())
            if (normalized.isEmpty()) return@setOnClickListener
            prefs.instance = normalized
            binding.instance.setText(normalized)
            Toast.makeText(this, R.string.save, Toast.LENGTH_SHORT).show()
            render()
        }

        binding.openButton.setOnClickListener {
            val intent = CustomTabsIntent.Builder().setShowTitle(true).build()
            runCatching { intent.launchUrl(this, Uri.parse(Prefs(this).instance)) }
        }

        render()
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun render() {
        val prefs = Prefs(this)
        if (prefs.isSignedIn) {
            binding.status.setText(R.string.signed_in_as)
            binding.authButton.setText(R.string.sign_out)
            binding.authButton.setOnClickListener { signOut() }
        } else {
            binding.status.setText(R.string.signed_out)
            binding.authButton.setText(R.string.sign_in_title)
            binding.authButton.setOnClickListener {
                startActivity(Intent(this, SignInActivity::class.java))
            }
        }
    }

    private fun signOut() {
        // Local only. Revoking the session server-side would be better, but a phone that
        // has lost its token cannot revoke anything, so the web app's session list is the
        // reliable place to do that — and this must work offline.
        Prefs(this).clearToken()
        lifecycleScope.launch { render() }
    }
}
