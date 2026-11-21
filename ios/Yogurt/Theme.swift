import SwiftUI
import UIKit

/// Desktop Yogurt's tokens (app/src/renderer/src/styles.css, the main window's `:root:not(.widget)` palette and its dark
/// twin), so the phone reads as the same app.
enum Theme {
    static let bg = dynamic(0xFFFFFF, 0x1B1B1D)
    static let chrome = dynamic(0xF3F3F3, 0x242425)
    static let card = dynamic(0xF6F6F6, 0x202021)
    static let float = dynamic(0xFFFFFF, 0x29292B)
    static let ink = dynamic(0x29292C, 0xE7E6EB)
    static let muted = dynamic(0x606066, 0xA7A4AD)
    static let heading = dynamic(0x29292C, 0xE7E6EB)
    /// the written summary, a step softer than ink
    static let written = dynamic(0x54545A, 0xC6C3CC)
    static let line = dynamic(0xE6E6E8, 0x343436)
    static let accent = dynamic(0x6F00FF, 0xB780FF)
    static let accentSoft = dynamic(0xF1E6FF, 0x2C164A)
    /// filled buttons and the tab underline stay the brand purple in both themes
    static let primary = Color(hex: 0x6F00FF)
    static let control = dynamic(0xECECEE, 0x333335)
    static let selected = dynamic(0xE4E2E8, 0x3B393F)
    static let rowPressed = dynamic(0xF0F0F1, 0x262628)
    static let live = dynamic(0x416D48, 0xAED4B5)
    static let danger = dynamic(0xB63C4D, 0xF098A5)
    static let dangerSoft = dynamic(0xF4E5E8, 0x59343C)
    /// the onboarding pictures' purple, as on desktop's first run
    static let art = dynamic(0x7142E8, 0xA48BF4)
    static let artSoft = dynamic(0xEEE9FC, 0x2D2445)

    /// Bricolage Grotesque SemiBold (bundled, OFL), desktop's brand face, for screen titles only.
    static func brand(_ size: CGFloat, relativeTo style: Font.TextStyle = .title) -> Font {
        .custom("BricolageGrotesque-SemiBold", size: size, relativeTo: style)
    }

    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

extension Color {
    init(hex: UInt32) { self.init(uiColor: UIColor(hex: hex)) }
}

/// A full-width purple button, like desktop's primary buttons.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 22)
            .frame(minHeight: 50)
            .background(Theme.primary.opacity(enabled ? 1 : 0.4), in: Capsule())
            .opacity(configuration.isPressed ? 0.85 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// A list row that darkens a little while pressed, the phone's version of desktop's row hover.
struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .background(configuration.isPressed ? Theme.rowPressed : .clear, in: RoundedRectangle(cornerRadius: 10))
    }
}
