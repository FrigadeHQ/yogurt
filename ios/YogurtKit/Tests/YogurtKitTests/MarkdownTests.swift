import Testing
@testable import YogurtKit

@Suite struct MarkdownTests {
    @Test func headingsBulletsAndParagraphs() {
        let md = """
        # Launch plan

        ## Decisions
        - Ship on **Friday**
          - after the review
        * Keep the beta small
        1. Write the post
        2) Tell support

        We agreed to meet again.
        Next week works.
        """
        #expect(markdownBlocks(md) == [
            .heading(level: 1, text: "Launch plan"),
            .heading(level: 2, text: "Decisions"),
            .bullet(level: 0, text: "Ship on **Friday**"),
            .bullet(level: 1, text: "after the review"),
            .bullet(level: 0, text: "Keep the beta small"),
            .numbered(number: 1, level: 0, text: "Write the post"),
            .numbered(number: 2, level: 0, text: "Tell support"),
            .paragraph("We agreed to meet again.\nNext week works."),
        ])
    }

    @Test func tasksRulesAndDeepHeadings() {
        #expect(markdownBlocks("- [ ] call Ada\n- [x] send notes\n---\n#### Small") == [
            .task(done: false, level: 0, text: "call Ada"),
            .task(done: true, level: 0, text: "send notes"),
            .rule,
            .heading(level: 3, text: "Small"),
        ])
    }

    @Test func oddInputStaysText() {
        #expect(markdownBlocks("") == [])
        #expect(markdownBlocks("   \n\n") == [])
        #expect(markdownBlocks("#hashtag and -dash") == [.paragraph("#hashtag and -dash")])
        #expect(markdownBlocks("\t- tabbed") == [.bullet(level: 1, text: "tabbed")])
    }
}
