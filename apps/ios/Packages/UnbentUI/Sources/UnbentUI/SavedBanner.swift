import SwiftUI

/// One thing a banner offers to do with what it announces.
public struct BannerAction: Identifiable {
    public let title: String
    public let run: () -> Void
    public var id: String { title }

    public init(_ title: String, run: @escaping () -> Void) {
        self.title = title
        self.run = run
    }
}

/// A line along the bottom of the shell saying a file was saved, with what can be done
/// with it.
///
/// Android says this with a notification, which the download manager posts for it. A file
/// saved inside an iOS app announces itself nowhere (it is simply in Files) so the app
/// says so, over the page, where the person was looking when they asked for it. It goes
/// after a few seconds on its own; the file does not.
public struct SavedBanner: View {
    private let text: String
    private let actions: [BannerAction]
    private let onDismiss: () -> Void

    public init(text: String, actions: [BannerAction] = [], onDismiss: @escaping () -> Void) {
        self.text = text
        self.actions = actions
        self.onDismiss = onDismiss
    }

    public var body: some View {
        HStack(spacing: Space.hair) {
            Text(text)
                .font(.subheadline)
                // A filename is as long as someone made it. Two lines, cut in the middle,
                // keeps the start and the extension, which are what identify it.
                .lineLimit(2)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, Space.small)
            ForEach(actions) { action in
                Button(action.title, action: action.run)
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, Space.small)
                    .frame(minHeight: 44)
            }
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(.leading, Space.large)
        .padding(.trailing, Space.hair)
        .padding(.vertical, Space.hair)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Metrics.radius, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: Metrics.radius, style: .continuous).strokeBorder(Color(.separator)) }
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
        .frame(maxWidth: Metrics.column + Space.screen * 2)
        .padding(.horizontal, Space.large)
        .padding(.bottom, Space.medium)
        .tint(.unbentAccent)
    }
}

#Preview {
    VStack {
        Spacer()
        SavedBanner(
            text: "Saved unbent-export-2026-10-03.zip to Files",
            actions: [BannerAction("Share") {}],
            onDismiss: {}
        )
    }
}
