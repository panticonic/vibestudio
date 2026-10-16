package app.vibestudio.mobile

import android.app.Activity
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.service.quicksettings.TileService
import android.text.InputType
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import org.json.JSONObject

/**
 * Quick Settings tile that asks a question without opening a client. Tapping
 * it opens a small prompt; the question runs as a background intent
 * server-side and the answer arrives as a notification (docs/client-hosts-and-clients-plan.md
 * 4.7.2). The host knows no client: it runs whichever one declares `ask`.
 */
class AskTileService : TileService() {
    override fun onClick() {
        super.onClick()
        val prompt = Intent(this, AskActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            val pending = PendingIntent.getActivity(this, 0, prompt, PendingIntent.FLAG_IMMUTABLE)
            startActivityAndCollapse(pending)
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(prompt)
        }
    }
}

/** The tile's prompt: one text field and Send. */
class AskActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setTitle(R.string.ask_tile_label)
        val field = EditText(this).apply {
            hint = getString(R.string.ask_tile_hint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 2
        }
        val send = Button(this).apply {
            text = getString(R.string.ask_tile_send)
            setOnClickListener {
                val text = AskRequest.text(field.text) ?: return@setOnClickListener
                HostIngress.forward(
                    JSONObject().put("type", "background-intent").put("name", AskRequest.INTENT).put("text", text),
                )
                finish()
            }
        }
        setContentView(
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                val pad = (16 * resources.displayMetrics.density).toInt()
                setPadding(pad, pad, pad, pad)
                addView(field, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                addView(send, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            },
        )
    }
}
