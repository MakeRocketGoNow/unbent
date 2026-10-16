import SwiftUI
import UnbentCore

/// The share sheet's own sheet: what was shared, where it goes, and one Save.
///
/// Filing at the moment of capture is the habit that keeps an archive usable. A capture
/// that lands in the Inbox to be named and filed "later" is a triage job that gets
/// skipped, so the title, notebook and tags are here, prefilled, so the lazy case is
/// still one tap. The notebook offered is wherever the last capture went, because shares
/// come in runs: five receipts in a row go to the same place.
///
/// Cancel and Save are in the bar at the top, where every sheet on an iPhone keeps them
/// and where the keyboard cannot cover them. Android's are at the foot of a bottom sheet,
/// which is that platform's place for them.
///
/// Signed out, the form is still here and Save still works: what was shared is staged on
/// the phone either way, and the app sends it after the next sign-in. Only the notebooks
/// and the suggested tags are missing, since there is nobody to ask for them as.
///
/// The same view is shown by the share extension and by the app, for a file opened in it
/// from another app. The Android app's half is `CaptureSheet.kt`.
public struct CaptureSheet: View {
    /// What the form's lists are filled from, once.
    public struct Choices: Sendable {
        public var notebooks: [Notebook]
        public var tags: [Tag]

        public init(notebooks: [Notebook] = [], tags: [Tag] = []) {
            self.notebooks = notebooks
            self.tags = tags
        }
    }

    private let summary: String?
    private let suggestedTitle: String
    private let problem: String?
    private let signedIn: Bool
    private let lastNotebook: String?
    private let load: () async -> Choices
    private let onSave: (_ title: String, _ notebook: String?, _ tags: [String]) -> Void
    private let onCancel: () -> Void

    @State private var title = ""
    /// Whether the title is the person's now. Staging names the share a moment after the
    /// sheet opens, and must not replace something already typed.
    @State private var titleEdited = false
    @State private var notebook: String?
    @State private var tags: [String] = []
    @State private var draft = ""
    @State private var choices = Choices()
    @FocusState private var titleFocused: Bool

    /// - Parameters:
    ///   - summary: "2 photos · 1 PDF", or nil while the files are still being copied,
    ///     which is what keeps Save disabled: saving before that would queue an upload of
    ///     files that are not there yet.
    ///   - suggestedTitle: the title staging derived. Empty until it has.
    ///   - problem: why there is nothing to save, shown in place of the form: a share
    ///     that held nothing this app can take, or nowhere to stage it.
    ///   - load: fetches the notebooks and tags. Called once, and only when signed in.
    public init(
        summary: String?,
        suggestedTitle: String,
        problem: String? = nil,
        signedIn: Bool,
        lastNotebook: String?,
        load: @escaping () async -> Choices,
        onSave: @escaping (_ title: String, _ notebook: String?, _ tags: [String]) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.summary = summary
        self.suggestedTitle = suggestedTitle
        self.problem = problem
        self.signedIn = signedIn
        self.lastNotebook = lastNotebook
        self.load = load
        self.onSave = onSave
        self.onCancel = onCancel
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.large) {
                    if let problem {
                        Text(problem)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        form
                    }
                }
                .padding(Space.screen)
                .frame(maxWidth: Metrics.column, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color.unbentGround)
            .navigationTitle("Save to Unbent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                if problem == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        // A tag still being typed goes too.
                        Button("Save") {
                            onSave(title.trimmingCharacters(in: .whitespaces), notebook, tagsWithDraft(tags, draft))
                        }
                        .fontWeight(.semibold)
                        .disabled(summary == nil)
                    }
                }
            }
        }
        .tint(.unbentAccent)
        .onAppear {
            title = suggestedTitle
            notebook = lastNotebook
        }
        .onChange(of: suggestedTitle) { _, suggested in
            if !titleEdited { title = suggested }
        }
        .task {
            guard signedIn else { return }
            choices = await load()
            // The remembered notebook may have been renamed or deleted since; the Inbox
            // is the honest fallback rather than a name the server would refuse. Only
            // once there is a list to check against: a failed load proves nothing.
            if let chosen = notebook, !choices.notebooks.isEmpty, !choices.notebooks.contains(where: { $0.name == chosen }) {
                notebook = nil
            }
        }
    }

    @ViewBuilder private var form: some View {
        VStack(alignment: .leading, spacing: Space.small) {
            // What was shared, or that it is still being copied. One line either way, so
            // the form under it does not move when the copy finishes.
            Text(summary ?? "Copying…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if !signedIn {
                Text("You’re signed out. Save this, then open Unbent and sign in, and it will be saved to your notes.")
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }

        Labelled("Title") {
            FieldBox(focused: titleFocused, onTap: { titleFocused = true }) {
                TextField("Title", text: $title)
                    .textInputAutocapitalization(.sentences)
                    .submitLabel(.done)
                    .focused($titleFocused)
                    .onChange(of: title) { _, typed in
                        if typed != suggestedTitle { titleEdited = true }
                    }
            }
        }

        Labelled("Notebook") {
            NotebookPicker(notebook: $notebook, notebooks: choices.notebooks)
        }

        Labelled("Tags") {
            TagEditor(tags: $tags, draft: $draft, suggestions: choices.tags)
        }
    }
}

/// A caption over the control it names. Sign-in's fields use their placeholder as the
/// label; these arrive filled in, and a filled field with no caption is a value with
/// nothing to say what it is.
private struct Labelled<Content: View>: View {
    let label: String
    @ViewBuilder var content: Content

    init(_ label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.hair) {
            Text(label)
                .font(.footnote)
                .foregroundStyle(.secondary)
            content
        }
    }
}

/// The notebook, as a box that states the choice and opens the system's menu to change it.
///
/// A menu rather than a list unfolding inside the sheet, which is what Android has and has
/// for a reason that is Android's: popups proved unreliable over its translucent share
/// activity. Here the menu is the system's, opens where the box is, and pushes nothing
/// else on the form out of the way.
private struct NotebookPicker: View {
    @Binding var notebook: String?
    let notebooks: [Notebook]

    var body: some View {
        Menu {
            Picker("Notebook", selection: $notebook) {
                // No notebook is the Inbox, and comes first: it is always there.
                Text("Inbox").tag(String?.none)
                ForEach(notebooks, id: \.id) { Text($0.name).tag(String?.some($0.name)) }
                // The last one used, shown before the list has loaded or signed out,
                // so the box never names a notebook the menu does not hold.
                if let notebook, !notebooks.contains(where: { $0.name == notebook }) {
                    Text(notebook).tag(String?.some(notebook))
                }
            }
        } label: {
            HStack(spacing: Space.small) {
                // A notebook's name is as long as someone made it.
                Text(notebook ?? "Inbox")
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                // The chevrons are what says this box opens rather than being typed in.
                Image(systemName: "chevron.up.chevron.down")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, Space.large)
            .frame(minHeight: Metrics.control)
            .background(Color(.secondarySystemBackground), in: shape)
            .overlay { shape.strokeBorder(Color(.separator)) }
            .contentShape(shape)
        }
        // A menu draws its label in the tint, and a notebook's name in green reads as a
        // link. It is a value in a box, like the title above it.
        .tint(.primary)
    }

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: Metrics.radius, style: .continuous) }
}

/// The note's tags: the ones it has as chips, a field to add one, and the account's other
/// tags as suggestions narrowed by what has been typed.
///
/// The field's text belongs to the sheet, not to this editor, because the sheet is the
/// one with a Save button: a tag still being typed when that is tapped has to go with it.
/// See `tagsWithDraft`.
private struct TagEditor: View {
    @Binding var tags: [String]
    @Binding var draft: String
    let suggestions: [Tag]
    @FocusState private var typing: Bool

    private func add(_ raw: String) {
        tags = tagsWithDraft(tags, raw)
        draft = ""
    }

    var body: some View {
        let offered = tagSuggestions(suggestions, tags: tags, draft: draft)
        VStack(alignment: .leading, spacing: Space.small) {
            if !tags.isEmpty {
                FlowLayout(spacing: Space.small) {
                    ForEach(tags, id: \.self) { tag in
                        Button {
                            tags.removeAll { $0 == tag }
                        } label: {
                            HStack(spacing: Space.hair) {
                                Text(tag).lineLimit(1)
                                Image(systemName: "xmark").font(.caption2.weight(.bold))
                            }
                        }
                        .buttonStyle(ChipStyle(filled: true))
                        .accessibilityLabel("Remove tag \(tag)")
                    }
                }
            }
            FieldBox(focused: typing, onTap: { typing = true }) {
                TextField("Add a tag", text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .focused($typing)
                    // Return adds the tag and keeps the cursor, for the next one.
                    .onSubmit {
                        add(draft)
                        typing = true
                    }
            }
            if !offered.isEmpty {
                FlowLayout(spacing: Space.small) {
                    ForEach(offered, id: \.self) { name in
                        Button(name) { add(name) }
                            .buttonStyle(ChipStyle(filled: false))
                            .accessibilityLabel("Add tag \(name)")
                    }
                }
            }
        }
    }
}

/// A tag as a chip. Filled for one the note has, outlined for one on offer, so the two
/// rows read as "these" and "or these" without a caption each.
private struct ChipStyle: ButtonStyle {
    let filled: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline)
            .foregroundStyle(filled ? Color.unbentOnAccent : .primary)
            .padding(.horizontal, Space.medium)
            // Shorter than a field, since a dozen of them wrap; the gap between rows
            // makes up the rest of a fingertip.
            .frame(minHeight: 36)
            .background(filled ? Color.unbentAccent : .clear, in: Capsule())
            .overlay { if !filled { Capsule().strokeBorder(Color(.separator)) } }
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// Lays its children out in rows, left to right, wrapping when one does not fit. SwiftUI
/// has stacks and grids and nothing that wraps.
private struct FlowLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let rows = arrange(subviews, in: width)
        return CGSize(width: proposal.width ?? rows.width, height: rows.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = arrange(subviews, in: bounds.width)
        for (subview, origin) in zip(subviews, rows.origins) {
            subview.place(
                at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y),
                // Never wider than the row: a tag longer than the screen truncates.
                proposal: ProposedViewSize(width: min(subview.sizeThatFits(.unspecified).width, bounds.width), height: nil)
            )
        }
    }

    private func arrange(_ subviews: Subviews, in width: CGFloat) -> (origins: [CGPoint], width: CGFloat, height: CGFloat) {
        var origins: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            var size = subview.sizeThatFits(.unspecified)
            size.width = min(size.width, width)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return (origins, widest, y + rowHeight)
    }
}

#Preview("Signed in") {
    CaptureSheet(
        summary: "2 photos · 1 PDF",
        suggestedTitle: "Capture 2026-09-01 14:30",
        signedIn: true,
        lastNotebook: "Coupons",
        load: { CaptureSheet.Choices() },
        onSave: { _, _, _ in },
        onCancel: {}
    )
}

#Preview("Signed out, copying") {
    CaptureSheet(
        summary: nil,
        suggestedTitle: "",
        signedIn: false,
        lastNotebook: nil,
        load: { CaptureSheet.Choices() },
        onSave: { _, _, _ in },
        onCancel: {}
    )
}
