import type { RenderLink } from "./RenderLink"
import type { ConnectingLink, ItemLocator, LinkNetwork, LinkSegment } from "@/interfaces"
import type { INodeInputSlot, INodeOutputSlot } from "@/interfaces"
import type { LGraphNode } from "@/LGraphNode"
import type { Reroute } from "@/Reroute"
import type { CanvasPointerEvent } from "@/types/events"
import type { IWidget } from "@/types/widgets"

import { LinkConnectorEventMap, LinkConnectorEventTarget } from "@/infrastructure/LinkConnectorEventTarget"
import { LLink } from "@/LLink"
import { LinkDirection } from "@/types/globalEnums"

import { getNodeOutputOnPos } from "./measureSlots"
import { MovingRenderLink } from "./MovingRenderLink"
import { ToInputRenderLink } from "./ToInputRenderLink"
import { ToOutputRenderLink } from "./ToOutputRenderLink"

/**
 * A Litegraph state object for the {@link LinkConnector}.
 * References are only held atomically within a function, never passed.
 * The concrete implementation may be replaced or proxied without side-effects.
 */
export interface LinkConnectorState {
  /**
   * The type of slot that links are being connected **to**.
   * - When `undefined`, no operation is being performed.
   * - A change in this property indicates the start or end of dragging links.
   */
  connectingTo: "input" | "output" | undefined
  multi: boolean
  /** When `true`, existing links are being repositioned. Otherwise, new links are being created. */
  draggingExistingLinks: boolean
}

/** Discriminated union to simplify type narrowing. */
type RenderLinkUnion = MovingRenderLink | ToInputRenderLink | ToOutputRenderLink

export interface LinkConnectorExport {
  renderLinks: RenderLink[]
  inputLinks: LLink[]
  outputLinks: LLink[]
  state: LinkConnectorState
  network: LinkNetwork
}

/**
 * Component of {@link LGraphCanvas} that handles connecting and moving links.
 * @see {@link LLink}
 */
export class LinkConnector {
  /**
   * Link connection state POJO. Source of truth for state of link drag operations.
   *
   * Can be replaced or proxied to allow notifications.
   * Is always dereferenced at the start of an operation.
   */
  state: LinkConnectorState = {
    connectingTo: undefined,
    multi: false,
    draggingExistingLinks: false,
  }

  readonly events = new LinkConnectorEventTarget()

  /** Contains information for rendering purposes only. */
  readonly renderLinks: RenderLinkUnion[] = []

  /** Existing links that are being moved **to** a new input slot. */
  readonly inputLinks: LLink[] = []
  /** Existing links that are being moved **to** a new output slot. */
  readonly outputLinks: LLink[] = []

  readonly hiddenReroutes: Set<Reroute> = new Set()

  /** The widget beneath the pointer, if it is a valid connection target. */
  overWidget?: IWidget
  /** The type (returned by downstream callback) for {@link overWidget} */
  overWidgetType?: string

  readonly #setConnectingLinks: (value: ConnectingLink[]) => void

  constructor(setConnectingLinks: (value: ConnectingLink[]) => void) {
    this.#setConnectingLinks = setConnectingLinks
  }

  get isConnecting() {
    return this.state.connectingTo !== undefined
  }

  get draggingExistingLinks() {
    return this.state.draggingExistingLinks
  }

  /** Drag an existing link to a different input. */
  moveInputLink(network: LinkNetwork, input: INodeInputSlot, fromReroute?: Reroute): void {
    if (this.isConnecting) throw new Error("Already dragging links.")

    const { state, inputLinks, renderLinks } = this

    const linkId = input.link
    if (linkId == null) return

    const link = network.links.get(linkId)
    if (!link) return

    try {
      const renderLink = new MovingRenderLink(network, link, "input", fromReroute)

      const mayContinue = this.events.dispatch("before-move-input", renderLink)
      if (mayContinue === false) return

      renderLinks.push(renderLink)
    } catch (error) {
      console.warn(`Could not create render link for link id: [${link.id}].`, link, error)
      return
    }

    link._dragging = true
    inputLinks.push(link)

    state.connectingTo = "input"
    state.draggingExistingLinks = true

    this.#setLegacyLinks(false)
  }

  /** Drag all links from an output to a new output. */
  moveOutputLink(network: LinkNetwork, output: INodeOutputSlot): void {
    if (this.isConnecting) throw new Error("Already dragging links.")

    const { state, renderLinks } = this
    if (!output.links?.length) return

    for (const linkId of output.links) {
      const link = network.links.get(linkId)
      if (!link) continue

      const firstReroute = LLink.getFirstReroute(network, link)
      if (firstReroute) {
        firstReroute._dragging = true
        this.hiddenReroutes.add(firstReroute)
      } else {
        link._dragging = true
      }
      this.outputLinks.push(link)

      try {
        const renderLink = new MovingRenderLink(network, link, "output", firstReroute, LinkDirection.RIGHT)

        const mayContinue = this.events.dispatch("before-move-output", renderLink)
        if (mayContinue === false) continue

        renderLinks.push(renderLink)
      } catch (error) {
        console.warn(`Could not create render link for link id: [${link.id}].`, link, error)
        continue
      }
    }

    if (renderLinks.length === 0) return this.reset()

    state.draggingExistingLinks = true
    state.multi = true
    state.connectingTo = "output"

    this.#setLegacyLinks(true)
  }

  /**
   * Drags a new link from an output slot to an input slot.
   * @param network The network that the link being connected belongs to
   * @param node The node the link is being dragged from
   * @param output The output slot that the link is being dragged from
   */
  dragNewFromOutput(network: LinkNetwork, node: LGraphNode, output: INodeOutputSlot, fromReroute?: Reroute): void {
    if (this.isConnecting) throw new Error("Already dragging links.")

    const { state } = this
    const renderLink = new ToInputRenderLink(network, node, output, fromReroute)
    this.renderLinks.push(renderLink)

    state.connectingTo = "input"

    this.#setLegacyLinks(false)
  }

  /**
   * Drags a new link from an input slot to an output slot.
   * @param network The network that the link being connected belongs to
   * @param node The node the link is being dragged from
   * @param input The input slot that the link is being dragged from
   */
  dragNewFromInput(network: LinkNetwork, node: LGraphNode, input: INodeInputSlot, fromReroute?: Reroute): void {
    if (this.isConnecting) throw new Error("Already dragging links.")

    const { state } = this
    const renderLink = new ToOutputRenderLink(network, node, input, fromReroute)
    this.renderLinks.push(renderLink)

    state.connectingTo = "output"

    this.#setLegacyLinks(true)
  }

  /**
   * Drags a new link from a reroute to an input slot.
   * @param network The network that the link being connected belongs to
   * @param reroute The reroute that the link is being dragged from
   */
  dragFromReroute(network: LinkNetwork, reroute: Reroute): void {
    if (this.isConnecting) throw new Error("Already dragging links.")

    const { state } = this

    // Connect new link from reroute
    const linkId = reroute.linkIds.values().next().value
    if (linkId == null) return

    const link = network.links.get(linkId)
    if (!link) return

    const outputNode = network.getNodeById(link.origin_id)
    if (!outputNode) return

    const outputSlot = outputNode.outputs.at(link.origin_slot)
    if (!outputSlot) return

    const renderLink = new ToInputRenderLink(network, outputNode, outputSlot, reroute)
    renderLink.fromDirection = LinkDirection.NONE
    this.renderLinks.push(renderLink)

    state.connectingTo = "input"
  }

  dragFromLinkSegment(network: LinkNetwork, linkSegment: LinkSegment): void {
    if (this.isConnecting) throw new Error("Already dragging links.")

    const { state } = this
    if (linkSegment.origin_id == null || linkSegment.origin_slot == null) return

    const node = network.getNodeById(linkSegment.origin_id)
    if (!node) return

    const slot = getNodeOutputOnPos(node, linkSegment._pos[0], linkSegment._pos[1])?.output
    if (!slot) return

    const reroute = linkSegment.parentId ? network.reroutes.get(linkSegment.parentId) : undefined
    if (!reroute) return

    const renderLink = new ToInputRenderLink(network, node, slot, reroute)
    renderLink.fromDirection = LinkDirection.NONE
    this.renderLinks.push(renderLink)

    state.connectingTo = "input"
  }

  /**
   * Connects the links being droppe
   * @param event Contains the drop location, in canvas space
   */
  dropLinks(locator: ItemLocator, event: CanvasPointerEvent): void {
    if (!this.isConnecting) return this.reset()

    const { renderLinks, state } = this
    const { connectingTo } = state

    const mayContinue = this.events.dispatch("before-drop-links", { renderLinks, event })
    if (mayContinue === false) return this.reset()

    const { canvasX, canvasY } = event
    const node = locator.getNodeOnPos(canvasX, canvasY) ?? undefined
    if (!node) return this.dropOnNothing(event)

    // To output
    if (connectingTo === "output") {
      const output = node.getOutputOnPos([canvasX, canvasY])

      if (output) {
        this.#dropOnOutput(node, output)
      } else {
        this.dropOnNode(node, event)
      }
    // To input
    } else if (connectingTo === "input") {
      const input = node.getInputOnPos([canvasX, canvasY])

      // Input slot
      if (input) {
        this.#dropOnInput(node, input)
      } else if (this.overWidget && this.renderLinks[0] instanceof ToInputRenderLink) {
        // Widget
        this.events.dispatch("dropped-on-widget", {
          link: this.renderLinks[0],
          node,
          widget: this.overWidget,
        })
        this.overWidget = undefined
      } else {
        // Node background / title
        this.dropOnNode(node, event)
      }
    }

    this.events.dispatch("after-drop-links", { renderLinks, event })
    this.reset()
  }

  /**
   * Connects the links being dropped onto a node.
   * @param node The node that the links are being dropped on
   * @param event Contains the drop location, in canvas space
   */
  dropOnNode(node: LGraphNode, event: CanvasPointerEvent): void {
    const { state: { connectingTo } } = this

    const mayContinue = this.events.dispatch("dropped-on-node", { node, event })
    if (mayContinue === false) return

    // Assume all links are the same type, disallow loopback
    const firstLink = this.renderLinks[0]
    if (!firstLink || firstLink.node === node) return

    // Dragging output links
    if (connectingTo === "output" && this.draggingExistingLinks) {
      const output = node.findOutputByType(firstLink.fromSlot.type)?.slot
      if (!output) {
        console.warn(`Could not find slot for link type: [${firstLink.fromSlot.type}].`)
        return
      }
      this.#dropOnOutput(node, output)
      return this.reset()
    }

    // Dragging input links
    if (connectingTo === "input" && this.draggingExistingLinks) {
      const input = node.findInputByType(firstLink.fromSlot.type)?.slot
      if (!input) {
        console.warn(`Could not find slot for link type: [${firstLink.fromSlot.type}].`)
        return
      }
      this.#dropOnInput(node, input)
      return this.reset()
    }

    // Dropping new output link
    if (connectingTo === "output") {
      const output = node.findOutputByType(firstLink.fromSlot.type)?.slot
      if (!output) {
        console.warn(`Could not find slot for link type: [${firstLink.fromSlot.type}].`)
        return
      }

      for (const link of this.renderLinks) {
        if ("link" in link.fromSlot) {
          node.connectSlots(output, link.node, link.fromSlot, link.fromReroute?.id)
        }
      }
    // Dropping new input link
    } else if (connectingTo === "input") {
      const input = node.findInputByType(firstLink.fromSlot.type)?.slot
      if (!input) {
        console.warn(`Could not find slot for link type: [${firstLink.fromSlot.type}].`)
        return
      }

      for (const link of this.renderLinks) {
        if ("links" in link.fromSlot) {
          link.node.connectSlots(link.fromSlot, node, input, link.fromReroute?.id)
        }
      }
    }

    this.reset()
  }

  dropOnNothing(event: CanvasPointerEvent): void {
    // For external event only.
    if (this.state.connectingTo === "input") {
      for (const link of this.renderLinks) {
        if (link instanceof MovingRenderLink) {
          link.inputNode.disconnectInput(link.inputIndex, true)
        }
      }
    }
    this.events.dispatch("dropped-on-canvas", event)
    this.reset()
  }

  #dropOnInput(node: LGraphNode, input: INodeInputSlot): void {
    for (const link of this.renderLinks) {
      if (link.toType !== "input") continue

      if (link instanceof MovingRenderLink) {
        const { outputNode, inputSlot, outputSlot, fromReroute } = link
        // Link is already connected here
        if (inputSlot === input) continue

        outputNode.connectSlots(outputSlot, node, input, fromReroute?.id)
        this.events.dispatch("input-moved", link)
      } else {
        const { node: outputNode, fromSlot, fromReroute } = link
        const newLink = outputNode.connectSlots(fromSlot, node, input, fromReroute?.id)
        this.events.dispatch("link-created", newLink)
      }
    }
  }

  #dropOnOutput(node: LGraphNode, output: INodeOutputSlot): void {
    for (const link of this.renderLinks) {
      if (link.toType !== "output") continue

      if (link instanceof MovingRenderLink) {
        const { inputNode, inputSlot, outputSlot } = link
        // Link is already connected here
        if (outputSlot === output) continue

        // Use the last reroute id on the link to retain all reroutes
        node.connectSlots(output, inputNode, inputSlot, link.link.parentId)
        this.events.dispatch("output-moved", link)
      } else {
        const { node: inputNode, fromSlot, fromReroute } = link
        const newLink = node.connectSlots(output, inputNode, fromSlot, fromReroute?.id)
        this.events.dispatch("link-created", newLink)
      }
    }
  }

  /** Sets connecting_links, used by some extensions still. */
  #setLegacyLinks(fromSlotIsInput: boolean): void {
    const links = this.renderLinks.map((link) => {
      const input = fromSlotIsInput ? link.fromSlot as INodeInputSlot : null
      const output = fromSlotIsInput ? null : link.fromSlot as INodeOutputSlot

      return {
        node: link.node,
        slot: link.fromSlotIndex,
        input,
        output,
        pos: link.fromPos,
      }
    })
    this.#setConnectingLinks(links)
  }

  /**
   * Exports the current state of the link connector.
   * @param network The network that the links being connected belong to.
   * @returns A POJO with the state of the link connector, links being connected, and their network.
   * @remarks Other than {@link network}, all properties are shallow cloned.
   */
  export(network: LinkNetwork): LinkConnectorExport {
    return {
      renderLinks: [...this.renderLinks],
      inputLinks: [...this.inputLinks],
      outputLinks: [...this.outputLinks],
      state: { ...this.state },
      network,
    }
  }

  /**
   * Adds an event listener that will be automatically removed when the reset event is fired.
   * @param eventName The event to listen for.
   * @param listener The listener to call when the event is fired.
   */
  listenUntilReset<K extends keyof LinkConnectorEventMap>(
    eventName: K,
    listener: Parameters<typeof this.events.addEventListener<K>>[1],
    options?: Parameters<typeof this.events.addEventListener<K>>[2],
  ) {
    this.events.addEventListener(eventName, listener, options)
    this.events.addEventListener("reset", () => this.events.removeEventListener(eventName, listener), { once: true })
  }

  /**
   * Resets everything to its initial state.
   *
   * Effectively cancels moving or connecting links.
   */
  reset(force = false): void {
    this.events.dispatch("reset", force)

    const { state, outputLinks, inputLinks, hiddenReroutes, renderLinks } = this

    if (!force && state.connectingTo === undefined) return
    state.connectingTo = undefined

    for (const link of outputLinks) delete link._dragging
    for (const link of inputLinks) delete link._dragging
    for (const reroute of hiddenReroutes) delete reroute._dragging

    renderLinks.length = 0
    inputLinks.length = 0
    outputLinks.length = 0
    hiddenReroutes.clear()
    state.multi = false
    state.draggingExistingLinks = false
  }
}
