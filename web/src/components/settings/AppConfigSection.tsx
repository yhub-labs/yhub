import { useState } from 'react'
import type { PluginConfigTool } from '../../api'
import { useI18n } from '../../i18n'
import { FieldRow, SectionCard, type SettingsSectionProps } from './shared'

export default function AppConfigSection({
  tool,
  settings,
  setKey,
  notify,
}: SettingsSectionProps & { tool: PluginConfigTool }) {
  const { t } = useI18n()
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const pluginId = tool.id
  const pluginConfigValues = (settings?.plugins as Record<string, Record<string, unknown>> | undefined)?.[pluginId] ?? {}

  const handleUpdate = async (fieldKey: string, val: unknown) => {
    const fullKey = `plugins.${pluginId}.${fieldKey}`
    setBusyKey(fieldKey)
    const res = await setKey(fullKey, val)
    setBusyKey(null)
    if (res.ok) {
      notify(t('settings.apps.updated', { name: tool.name }), 'info')
    }
  }

  const decls = tool.config ?? []

  return (
    <div className="space-y-5" data-section={`app-${pluginId}`}>
      <SectionCard
        title={`${tool.icon || '📦'} ${tool.name}`}
        description={t('settings.apps.blurb', { name: tool.name })}
        footer={t('settings.apps.footer', { id: pluginId })}
      >
        {decls.map((decl) => {
          const currentVal = pluginConfigValues[decl.key] ?? decl.default ?? ''
          const busy = busyKey === decl.key
          const isSecret = decl.key.includes('token') || decl.key.includes('secret') || decl.key.includes('password')
          return (
            <FieldRow
              key={decl.key}
              label={decl.key}
              hint={decl.help}
            >
              {decl.type === 'bool' ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleUpdate(decl.key, !currentVal)}
                  className="rounded-lg border border-white/15 px-3 py-1 text-xs text-neutral-200 hover:bg-white/5"
                >
                  {currentVal ? t('settings.on') : t('settings.off')}
                  {t('settings.apps.toggle')}
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type={isSecret ? 'password' : 'text'}
                    className="rounded-lg border border-white/15 bg-black/20 px-2.5 py-1 font-mono text-xs text-white placeholder-neutral-500 outline-none w-64"
                    defaultValue={String(currentVal)}
                    onBlur={(e) => {
                      if (e.target.value !== String(currentVal)) {
                        void handleUpdate(decl.key, e.target.value)
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.currentTarget.blur()
                      }
                    }}
                  />
                </div>
              )}
            </FieldRow>
          )
        })}
      </SectionCard>
    </div>
  )
}
