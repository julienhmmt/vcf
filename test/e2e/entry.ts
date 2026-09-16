import { detectLoginForms } from '../../src/content/detect'
import { fillLoginForm } from '../../src/content/inject'

interface VcfTestApi {
  detectLoginForms: typeof detectLoginForms
  fillLoginForm: typeof fillLoginForm
}

declare global {
  interface Window {
    VCF?: VcfTestApi
  }
}

window.VCF = { detectLoginForms, fillLoginForm }
