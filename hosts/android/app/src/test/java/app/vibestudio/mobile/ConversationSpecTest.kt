package app.vibestudio.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationSpecTest {
    private fun spec(conversation: String = CONVERSATION, data: String = """{\"senderHandle\":\"news\",\"notificationId\":\"n1\"}""") =
        ConversationSpec.parse(
            """
            {"id":"ws/n1","title":"Briefing","body":"3 stories","priority":"high",
             "actions":[{"id":"reply","title":"Reply"}],
             "dataJson":"$data",
             "conversation":$conversation}
            """.trimIndent(),
        )

    @Test
    fun parsesWhatTheHostRuntimeSends() {
        val parsed = spec()
        assertEquals("ws/n1", parsed.id)
        assertTrue(parsed.high)
        assertEquals(listOf(ReplyAction("reply", "Reply")), parsed.actions)
        assertEquals("chat", parsed.conversation?.clientId)
        assertEquals("news", parsed.sender)
    }

    @Test
    fun theSenderFallsBackToTheTitle() {
        assertEquals("Briefing", spec(data = """{\"notificationId\":\"n1\"}""").sender)
    }

    @Test
    fun anEntryWithoutAConversationIsNotABubbleAndHasNoShortcut() {
        val plain = spec(conversation = "null")
        assertNull(plain.conversation)
        assertFalse(plain.bubbleEligible(34))
        assertNull(plain.shortcutId)
    }

    @Test
    fun bubblesNeedAndroid11AndAConversation() {
        val withConversation = spec()
        assertFalse(withConversation.bubbleEligible(ConversationSpec.BUBBLES_SDK - 1))
        assertTrue(withConversation.bubbleEligible(ConversationSpec.BUBBLES_SDK))
        assertEquals("conversation:vibestudio://c/chat/open-conversation?conversation=ch-1", withConversation.shortcutId)
    }

    @Test
    fun aTypedReplyBecomesAHostRuntimeEventCarryingTheOriginalData() {
        val event = ConversationSpec.event("action", "reply", "on my way", """{"notificationId":"n1"}""")
        assertEquals("notification-event", event.getString("type"))
        assertEquals("action", event.getString("kind"))
        assertEquals("reply", event.getString("actionId"))
        assertEquals("on my way", event.getString("input"))
        assertEquals("n1", event.getJSONObject("data").getString("notificationId"))
    }

    @Test
    fun aPressCarriesNoActionOrInput() {
        val event: JSONObject = ConversationSpec.event("press", null, null, "{}")
        assertFalse(event.has("actionId"))
        assertFalse(event.has("input"))
    }

    companion object {
        private const val CONVERSATION =
            """{"link":"vibestudio://c/chat/open-conversation?conversation=ch-1","tag":"client:chat:react-native:dev","clientId":"chat","title":"Chat"}"""
    }
}
