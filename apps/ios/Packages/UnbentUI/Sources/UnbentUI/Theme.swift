import SwiftUI
import UIKit

/// The spacing vocabulary, the same steps as the Android app's `Space`.
///
/// A step scale leaves fewer choices (a gap is one of these or it is wrong), which is what
/// keeps several screens written at different times reading as one hand. 4pt multiples,
/// because the system's own controls are built on that grid.
public enum Space {
    /// Between a label and the thing it labels. Tighter than `small` on purpose.
    public static let hair: CGFloat = 4

    /// Within a group: icon to text, a caption under its control.
    public static let small: CGFloat = 8

    /// Between rows of different things: one field and the next.
    public static let medium: CGFloat = 12

    /// Between a group of fields and the action under it, and around a divider.
    public static let large: CGFloat = 16

    /// Around a screen that is mostly one column (sign-in, an empty state) and between
    /// its sections.
    public static let screen: CGFloat = 24
}

public enum Metrics {
    /// The height of anything tapped or typed into. Above the 44pt minimum on purpose: a
    /// column of buttons and fields reads as one rhythm only if they are one height, and
    /// 48 is the Android app's, so the two sign-in screens have the same proportions.
    public static let control: CGFloat = 48

    /// Buttons and fields. Rounder than the site's boxes, squarer than a capsule: the
    /// system's own controls sit about here, and a web radius reads as foreign on a phone.
    public static let radius: CGFloat = 12

    /// A column of fields stops growing here; on an iPad it sits centred instead of
    /// stretching a text field across the whole screen.
    public static let column: CGFloat = 420
}

public extension Color {
    /// Unbent's green, the site's `--accent` in each theme.
    ///
    /// Two values and not one: the light theme's green is too dark to sit on a near-black
    /// ground (as a button fill it reads as a hole, and as text it fails contrast) so
    /// dark mode lifts the hue until it carries.
    static let unbentAccent = Color(UIColor.unbentAccent)

    /// The site's `--bg` in each theme: the ground the native screens stand on too, so
    /// moving between a page and one of them is not a change of paper. The system's own
    /// background is pure white and pure black, and beside the page both read as a flash.
    static let unbentGround = Color(UIColor.unbentGround)

    /// What is written on a fill of `unbentAccent`. Dark mode inverts it: the lifted green
    /// is light, so its label has to be dark where the light theme's is white.
    static let unbentOnAccent = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(rgb: 0x04150C) : .white })
}

public extension UIColor {
    /// `Color.unbentAccent` for UIKit: the tint of the alerts the page raises.
    static let unbentAccent = UIColor { $0.userInterfaceStyle == .dark ? UIColor(rgb: 0x7FC3A0) : UIColor(rgb: 0x2F6F4F) }

    /// `Color.unbentGround` for UIKit: what the shell paints before the page has said
    /// what colour it is.
    static let unbentGround = UIColor { $0.userInterfaceStyle == .dark ? UIColor(rgb: 0x16151A) : UIColor(rgb: 0xFBFAF8) }

    convenience init(rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xff) / 255,
            green: CGFloat((rgb >> 8) & 0xff) / 255,
            blue: CGFloat(rgb & 0xff) / 255,
            alpha: 1
        )
    }
}

/// How loud a button is. The same three the site's `Button` component has, for the same
/// reasons: one filled action per screen, outlined for a real action that is not the main
/// one, and quiet for the rest.
public enum ButtonKind {
    case primary, secondary, quiet
}

/// The app's buttons. Full width by default, because every screen here is one column and
/// a button narrower than the field above it looks like it belongs to something else;
/// `compact` is for a row of two.
public struct UnbentButtonStyle: ButtonStyle {
    private let kind: ButtonKind
    private let compact: Bool
    @Environment(\.isEnabled) private var enabled

    public init(_ kind: ButtonKind, compact: Bool = false) {
        self.kind = kind
        self.compact = compact
    }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(kind == .quiet ? .regular : .semibold))
            .multilineTextAlignment(.center)
            .foregroundStyle(foreground)
            .padding(.horizontal, Space.large)
            .frame(maxWidth: compact ? nil : .infinity, minHeight: compact && kind == .quiet ? 44 : Metrics.control)
            .background(background, in: shape)
            .overlay { if kind == .secondary { shape.strokeBorder(Color(.separator)) } }
            .contentShape(shape)
            // A disabled button fades as a whole rather than changing colour, so it still
            // reads as the same control it will be once the form is filled in.
            .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
    }

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: Metrics.radius, style: .continuous) }

    private var foreground: Color {
        switch kind {
        case .primary: .unbentOnAccent
        case .secondary: .primary
        case .quiet: .unbentAccent
        }
    }

    private var background: Color {
        kind == .primary ? .unbentAccent : .clear
    }
}

public extension ButtonStyle where Self == UnbentButtonStyle {
    static func unbent(_ kind: ButtonKind, compact: Bool = false) -> UnbentButtonStyle {
        UnbentButtonStyle(kind, compact: compact)
    }
}

/// A text field drawn as a box the height of a button, with its border in the accent while
/// it is being typed into. The placeholder is the label: every field here is one word
/// (Email, Password, Code) and a label above each would double the height of a form whose
/// whole job is to be short.
///
/// The form owns the focus and tells the box about it, so a field has one focus state
/// rather than the form's and a second one here that has to be kept agreeing with it.
struct FieldBox<Content: View>: View {
    let focused: Bool
    /// The padding around the text is not the text field, so a tap there has to be handed
    /// on. Otherwise only the one line of text in a 48pt box would take it.
    let onTap: () -> Void
    @ViewBuilder var content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Metrics.radius, style: .continuous)
        content
            .padding(.horizontal, Space.large)
            .frame(minHeight: Metrics.control)
            .background(Color(.secondarySystemBackground), in: shape)
            .overlay { shape.strokeBorder(focused ? Color.unbentAccent : Color(.separator)) }
            .contentShape(shape)
            .onTapGesture(perform: onTap)
    }
}
