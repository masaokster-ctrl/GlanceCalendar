import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { createApp } from './app'
import { mountUi, setCompanionStatus, setConnectActionVisible } from './ui'
import { BridgeProductTokenStore } from './product/tokenStore'
import { getOrCreateInstallationId } from './product/installationId'

mountUi()

const bridge = await waitForEvenAppBridge()

// devセッションが無い(=製品モード)場合のみ実際に使われる。devモードでは無害に生成・保存されるだけ。
const tokenStore = new BridgeProductTokenStore(bridge)
const productInstallationId = await getOrCreateInstallationId(bridge)

const app = createApp(bridge, { tokenStore, productInstallationId, onPairingScreenActive: setConnectActionVisible })

await app.start()
setCompanionStatus('準備完了 — G2側の画面を確認してください')

window.addEventListener('beforeunload', () => {
  app.dispose()
})
