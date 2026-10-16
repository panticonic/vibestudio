package app.vibestudio.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LaunchSurfacesTest {
    private fun item(client: String, intent: String, label: String = intent, query: String = "") =
        LaunchItem(intent, label, "vibestudio://c/$client/$intent$query")

    private fun client(id: String, shortcuts: List<LaunchItem>, recent: List<LaunchItem> = emptyList()) =
        ClientSurfaces(id, id.replaceFirstChar { it.uppercase() }, shortcuts, recent)

    private val chat = client(
        "chat",
        listOf(item("chat", "open", "Chat")),
        listOf(
            item("chat", "open-conversation", "Standup", "?conversation=a"),
            item("chat", "open-conversation", "Release", "?conversation=b"),
        ),
    )
    private val notes = client("notes", listOf(item("notes", "open", "Notes"), item("notes", "new-note", "New note")))

    @Test
    fun parsesThePublishedJson() {
        val json = """
            {"clients":[{"clientId":"chat","title":"Chat",
              "shortcuts":[{"intent":"open","label":"Chat","link":"vibestudio://c/chat/open"}],
              "recent":[{"intent":"open-conversation","label":"Standup","link":"vibestudio://c/chat/open-conversation?conversation=a"}]}],
             "background":[{"clientId":"chat","clientTitle":"Chat","intent":"ask","title":"Ask","textParam":"text"}],
             "shareIn":[]}
        """.trimIndent()
        val parsed = LaunchSurfaces.parse(json)
        assertEquals(1, parsed.clients.size)
        assertEquals("Standup", parsed.clients[0].recent[0].label)
        assertTrue(parsed.canAsk)
        assertFalse(LaunchSurfaces.parse("""{"clients":[],"background":[],"shareIn":[]}""").canAsk)
    }

    @Test
    fun everyClientsOpenComesBeforeAnyClientsOtherEntries() {
        val plan = DynamicShortcutPlan.plan(LaunchSurfaces(listOf(chat, notes), canAsk = false), 10)
        assertEquals(
            listOf(
                "vibestudio://c/chat/open",
                "vibestudio://c/notes/open",
                "vibestudio://c/notes/new-note",
                "vibestudio://c/chat/open-conversation?conversation=a",
                "vibestudio://c/chat/open-conversation?conversation=b",
            ),
            plan.map { it.id },
        )
    }

    @Test
    fun theLauncherLimitCutsFromTheEndSoOpensSurvive() {
        val plan = DynamicShortcutPlan.plan(LaunchSurfaces(listOf(chat, notes), canAsk = false), 2)
        assertEquals(listOf("Chat", "Notes"), plan.map { it.shortLabel })
        assertTrue(DynamicShortcutPlan.plan(LaunchSurfaces(listOf(chat), canAsk = false), 0).isEmpty())
    }

    @Test
    fun aShortcutsIdIsItsLinkSoAPinnedCopyIsUpdatedNotDuplicated() {
        val spec = DynamicShortcutPlan.plan(LaunchSurfaces(listOf(chat), canAsk = false), 5)[1]
        assertEquals(spec.link, spec.id)
        assertEquals("Chat: Standup", spec.longLabel)
        assertEquals("Standup", spec.shortLabel)
    }

    @Test
    fun repeatedLinksAppearOnce() {
        val twice = client("chat", listOf(item("chat", "open", "Chat"), item("chat", "open", "Chat again")))
        assertEquals(1, DynamicShortcutPlan.plan(LaunchSurfaces(listOf(twice), canAsk = false), 5).size)
    }

    @Test
    fun theWidgetListsTheFirstClientWithDynamicEntries() {
        val content = WidgetContent.of(LaunchSurfaces(listOf(notes, chat), canAsk = true), 5)
        assertEquals("Chat", content.title)
        assertEquals(listOf("Standup", "Release"), content.entries.map { it.label })
        assertTrue(content.canAsk)
        assertEquals(1, WidgetContent.of(LaunchSurfaces(listOf(chat), canAsk = false), 1).entries.size)
    }

    @Test
    fun theWidgetFallsBackToPlainLaunchersAndToNothing() {
        assertEquals(
            listOf("Notes", "New note"),
            WidgetContent.of(LaunchSurfaces(listOf(notes), canAsk = false), 5).entries.map { it.label },
        )
        assertTrue(WidgetContent.of(LaunchSurfaces.EMPTY, 5).entries.isEmpty())
    }
}
