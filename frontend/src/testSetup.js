import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
// jsdom has no native modal implementation; real browsers own focus trapping.
HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
afterEach(() => cleanup())
