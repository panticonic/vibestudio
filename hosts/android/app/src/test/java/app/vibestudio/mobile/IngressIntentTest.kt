package app.vibestudio.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class IngressIntentTest {
    @Test
    fun clientLinkIsForwardedAsLink() {
        assertEquals(
            IngressIntent.Link("vibestudio://c/chat/open-conversation?conversation=a%20b"),
            IngressIntent.classify(IngressIntent.ACTION_VIEW, "vibestudio://c/chat/open-conversation?conversation=a%20b", null, null),
        )
    }

    @Test
    fun otherViewLinksAreNotIngress() {
        assertNull(IngressIntent.classify(IngressIntent.ACTION_VIEW, "vibestudio://connect?x=1", null, null))
        assertNull(IngressIntent.classify(IngressIntent.ACTION_VIEW, "https://example.com/c/chat/open", null, null))
        assertNull(IngressIntent.classify(IngressIntent.ACTION_VIEW, null, null, null))
    }

    @Test
    fun sharedTextCarriesItsTypeAndText() {
        assertEquals(
            IngressIntent.Share("text/plain", "look at this"),
            IngressIntent.classify(IngressIntent.ACTION_SEND, null, "text/plain", "look at this"),
        )
    }

    @Test
    fun shareWithoutTextOrWithANonTextTypeIsDropped() {
        assertNull(IngressIntent.classify(IngressIntent.ACTION_SEND, null, "text/plain", "   "))
        assertNull(IngressIntent.classify(IngressIntent.ACTION_SEND, null, "text/plain", null))
        assertNull(IngressIntent.classify(IngressIntent.ACTION_SEND, null, "image/png", "caption"))
        assertNull(IngressIntent.classify(IngressIntent.ACTION_SEND, null, null, "caption"))
        assertNull(IngressIntent.classify(IngressIntent.ACTION_SEND, null, "plain", "caption"))
    }

    @Test
    fun unknownActionsAreIgnored() {
        assertNull(IngressIntent.classify("android.intent.action.MAIN", null, null, null))
        assertNull(IngressIntent.classify(null, null, null, null))
    }

    @Test
    fun askTextIsTrimmedAndBlankIsNothing() {
        assertEquals("what time is it", AskRequest.text("  what time is it \n"))
        assertNull(AskRequest.text("   "))
        assertNull(AskRequest.text(null))
    }
}
