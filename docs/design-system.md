# OpenVac Web V1 design system

The visual direction is deliberately restrained: generous white space, strong
Chinese typography, direct task entry, and evidence-first product language.
It borrows interaction rhythm from contemporary AI product sites without
copying OpenAI branding, logo, font files, or proprietary assets.

## Tokens

- Canvas: `#ffffff`
- Subtle surface: `#f6f7f7`
- Primary ink: `#111315`
- Secondary ink: `#687076`
- Border: `#d9dede`
- Evidence/safe state: `#0f7c75`
- Review/warning: `#a86816`
- Spacing base: 8px
- Radius: 10px for controls, 14px for the primary composer
- Border: 1px; shadows are used only for focus and floating mobile navigation

## Typography

Use the local system stack:

`Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`

The homepage headline is 56px on desktop and scales to 42px on small screens.
Long expert answers use a 760px readable column with 1.75 line height.

## Product rules

- The primary action is always a plain-language question, never a model picker.
- User-facing V1 accepts text only. Do not render upload or attachment controls.
- Never show remaining answer quota. Only show the reset time after exhaustion.
- Every answer renders five sections in this order: conclusion, assumptions,
  evidence and sources, missing inputs, next step.
- Teal communicates verified evidence or a safe action, not decoration.
- High-risk answers stop at safe shutdown, isolation, inspection, and expert
  escalation.
- Manufacturer and standards material is metadata/link-only unless a separate,
  documented commercial AI licence has been approved.

## Visual reference boundary

The implementation was reviewed against generated landing, chat-workspace, and
knowledge-admin concepts. Those working references are not runtime assets and
are intentionally excluded from the public application bundle.
