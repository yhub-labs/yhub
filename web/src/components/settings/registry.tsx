// Settings section registry: adding a section = one `settings/<Xxx>Section.tsx` + one entry here
//
// The cross-section read/write channel, navigation and content container live in `Settings.tsx`
// (the shell); section files only render themselves. Array order = left nav order; `blurb` is used
// for both the nav item and the section header.
//
// `name` / `blurb` hold i18n keys (see web/src/i18n/catalogs/settings.ts): the shell translates them
// at render (`settings.<id>.name` / `settings.<id>.blurb`), so switching the language updates the
// navigation without a reload.

import GeneralSection from './GeneralSection'
import HotkeySection from './HotkeySection'
import CapsulesSection from './CapsulesSection'
import PluginsSection from './PluginsSection'
import TraySection from './TraySection'
import type { SettingsSection } from './shared'

export const BASE_SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'general',
    name: 'settings.general.name',
    icon: 'settings',
    group: 'core',
    blurb: 'settings.general.blurb',
    render: (props) => <GeneralSection {...props} />,
  },
  {
    id: 'hotkeys',
    name: 'settings.hotkeys.name',
    icon: 'keyboard',
    group: 'core',
    blurb: 'settings.hotkeys.blurb',
    render: (props) => <HotkeySection {...props} />,
  },
  {
    id: 'tray',
    name: 'settings.tray.name',
    icon: 'tray',
    group: 'core',
    blurb: 'settings.tray.blurb',
    render: (props) => <TraySection {...props} />,
  },
  {
    id: 'capsules',
    name: 'settings.capsules.name',
    icon: 'capsule',
    group: 'extension',
    blurb: 'settings.capsules.blurb',
    render: (props) => <CapsulesSection {...props} />,
  },
  {
    id: 'plugins',
    name: 'settings.plugins.name',
    icon: 'plugin',
    group: 'extension',
    blurb: 'settings.plugins.blurb',
    render: (props) => <PluginsSection {...props} />,
  },
]

export const SETTINGS_SECTIONS = BASE_SETTINGS_SECTIONS
