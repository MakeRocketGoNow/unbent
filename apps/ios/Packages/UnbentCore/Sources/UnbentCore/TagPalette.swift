import Foundation

/// The site's palette for tags, for the chips the share sheet draws itself.
///
/// A tag's colour is an index into this list, stored on its row by the server and sent on
/// every tag (`Tag.color`); the app never decides one, so a chip here is the chip the site
/// draws for the same tag without the two sharing any code. The ten hues are the
/// stylesheet's `--tint-0` to `--tint-9` (nine hues and a grey), in the same order, and the
/// Android app keeps the same copy in `TagColors.kt`. Change all three together.
///
/// A chip's fill and ink are mixed from its hue as the stylesheet mixes them: the fill is a
/// wash of the hue over the page's `--bg`, and the ink is the hue blended most of the way
/// into `--fg`, at one pair of ratios on the light theme and a deeper pair on the dark
/// (`--tint-wash` and `--tint-ink`). The ground and text are the site's rather than the
/// system's because the sheet stands on the site's ground (`Color.unbentGround`).
///
/// An index the list does not have (nil from a server older than the colours, or a palette
/// that has grown past this copy) draws the neutral chip: the text colour's own wash, which
/// is what the site draws for a tag with no colour yet.
///
/// Colours are `0xRRGGBB`, so this stays Foundation only and is tested on the Mac.
public enum TagPalette {
    public static let hues: [UInt32] = [
        0xC94F58, // red
        0xD2742F, // orange
        0xC9A227, // yellow
        0x5F9A48, // green
        0x3B9A8F, // teal
        0x4A7FC7, // blue
        0x8B63C7, // purple
        0xC9568F, // pink
        0x9A6B4A, // brown
        0x8C8781, // grey
    ]

    /// The site's `--bg` and `--fg` in each theme.
    static func ground(dark: Bool) -> UInt32 { dark ? 0x16151A : 0xFBFAF8 }
    static func text(dark: Bool) -> UInt32 { dark ? 0xEAE7E2 : 0x1C1A17 }

    /// The hue an index names, or the text colour itself for none, as `--chip-hue` falls back.
    public static func hue(_ index: Int?, dark: Bool) -> UInt32 {
        guard let index, hues.indices.contains(index) else { return text(dark: dark) }
        return hues[index]
    }

    /// A chip's fill: the hue washed over the ground.
    public static func fill(_ index: Int?, dark: Bool) -> UInt32 {
        mix(ground(dark: dark), hue(index, dark: dark), dark ? 0.26 : 0.16)
    }

    /// A chip's text: the hue blended toward the text colour, further on dark.
    public static func ink(_ index: Int?, dark: Bool) -> UInt32 {
        mix(text(dark: dark), hue(index, dark: dark), dark ? 0.50 : 0.70)
    }

    /// `from` moved `amount` of the way to `to`, channel by channel in sRGB, as
    /// `color-mix(in srgb, to amount, from)` does.
    static func mix(_ from: UInt32, _ to: UInt32, _ amount: Double) -> UInt32 {
        var out: UInt32 = 0
        for shift in [16, 8, 0] as [UInt32] {
            let a = Double((from >> shift) & 0xFF)
            let b = Double((to >> shift) & 0xFF)
            out |= UInt32((a + (b - a) * amount).rounded()) << shift
        }
        return out
    }
}
