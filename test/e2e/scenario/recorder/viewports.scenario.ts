import { IncrementalSource, ViewportResizeData, ScrollData } from '@datadog/browser-rum/cjs/types'
import { RumInitConfiguration } from '@datadog/browser-rum-core'

import { findAllIncrementalSnapshots, findAllVisualViewports } from '@datadog/browser-rum/test/utils'
import { createTest, bundleSetup, html, EventRegistry } from '../../lib/framework'
import { browserExecute } from '../../lib/helpers/browser'
import { flushEvents } from '../../lib/helpers/sdk'

const VIEWPORT_META_TAGS = `
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="viewport"
  content="width=device-width, initial-scale=1.0, maximum-scale=2.75, minimum-scale=1.0, user-scalable=yes"
>
`

describe('recorder', () => {
  beforeEach(() => {
    if (isGestureUnsupported()) {
      pending('no touch gesture support')
    }
  })

  describe('layout viewport properties', () => {
    createTest('getWindowWidth/Height should not be affected by pinch zoom')
      .withRum({ enableExperimentalFeatures: ['visualviewport'] })
      .withRumInit(initRumAndStartRecording)
      .withSetup(bundleSetup)
      .withBody(html`${VIEWPORT_META_TAGS}`)
      .run(async ({ events }) => {
        await buildScrollablePage()

        const { innerWidth, innerHeight } = await getWindowInnerDimensions()
        await performSignificantZoom()

        await browserExecute(() => {
          window.dispatchEvent(new Event('resize'))
        })

        const lastViewportResizeData = (
          await getLastRecord(events, (segment) =>
            findAllIncrementalSnapshots(segment, IncrementalSource.ViewportResize)
          )
        ).data as ViewportResizeData

        const scrollbarWidth = await getScrollbarCorrection()

        expectToBeNearby(lastViewportResizeData.width, innerWidth - scrollbarWidth)
        expectToBeNearby(lastViewportResizeData.height, innerHeight - scrollbarWidth)
      })

    /**
     * window.ScrollX/Y on some devices/browsers are changed by pinch zoom
     * We need to ensure that our measurements are not affected by pinch zoom
     */
    createTest('getScrollX/Y should not be affected by pinch scroll')
      .withRum({ enableExperimentalFeatures: ['visualviewport'] })
      .withRumInit(initRumAndStartRecording)
      .withSetup(bundleSetup)
      .withBody(html`${VIEWPORT_META_TAGS}`)
      .run(async ({ events }) => {
        const VISUAL_SCROLL_DOWN_PX = 60
        const LAYOUT_SCROLL_AMOUNT = 20

        await buildScrollablePage()
        await performSignificantZoom()
        await resetLayoutScroll()

        const initialVisualViewport = await getVisualViewport()
        const { scrollX: initialScrollX, scrollY: initialScrollY } = await getWindowScroll()

        // Add Visual Viewport Scroll
        await pinchScrollVerticallyDown(VISUAL_SCROLL_DOWN_PX)

        // Add Layout Viewport Scroll
        await layoutScrollTo(LAYOUT_SCROLL_AMOUNT, LAYOUT_SCROLL_AMOUNT)

        const nextVisualViewport = await getVisualViewport()
        const { scrollX: nextScrollX, scrollY: nextScrollY } = await getWindowScroll()

        await browserExecute(() => {
          document.dispatchEvent(new Event('scroll'))
        })

        const lastScrollData = (
          await getLastRecord(events, (segment) => findAllIncrementalSnapshots(segment, IncrementalSource.Scroll))
        ).data as ScrollData

        // Height changes because URL address bar changes due to scrolling
        const navBarHeightChange = nextVisualViewport.height - initialVisualViewport.height
        expect(navBarHeightChange).toBeLessThanOrEqual(30)

        // Visual Viewport Scroll should change without visual viewport affect
        expectToBeNearby(lastScrollData.x, initialScrollX + LAYOUT_SCROLL_AMOUNT)
        expectToBeNearby(lastScrollData.y, initialScrollY + LAYOUT_SCROLL_AMOUNT)
        expectToBeNearby(lastScrollData.x, nextScrollX)
        expectToBeNearby(lastScrollData.y, nextScrollY)
      })
  })

  describe('visual viewport properties', () => {
    createTest('pinch zoom "resize" event reports visual viewport scale and dimension')
      .withRum({ enableExperimentalFeatures: ['visualviewport'] })
      .withRumInit(initRumAndStartRecording)
      .withSetup(bundleSetup)
      .withBody(html`${VIEWPORT_META_TAGS}`)
      .run(async ({ events }) => {
        const initialVisualViewportDimension = await getVisualViewport()
        await performSignificantZoom()
        const nextVisualViewportDimension = await getVisualViewport()

        const lastVisualViewportRecord = await getLastRecord(events, findAllVisualViewports)

        // SDK returns Visual Viewport object
        expectToBeNearby(lastVisualViewportRecord.data.scale, nextVisualViewportDimension.scale)
        expectToBeNearby(lastVisualViewportRecord.data.width, nextVisualViewportDimension.width)
        expectToBeNearby(lastVisualViewportRecord.data.height, nextVisualViewportDimension.height)
        expectToBeNearby(lastVisualViewportRecord.data.offsetLeft, nextVisualViewportDimension.offsetLeft)
        expectToBeNearby(lastVisualViewportRecord.data.offsetTop, nextVisualViewportDimension.offsetTop)
        expectToBeNearby(lastVisualViewportRecord.data.pageLeft, nextVisualViewportDimension.pageLeft)
        expectToBeNearby(lastVisualViewportRecord.data.pageTop, nextVisualViewportDimension.pageTop)

        // With correct transformation
        const finalScaleAmount = nextVisualViewportDimension.scale
        expect(3).toBe(Math.round(finalScaleAmount))
        expectToBeNearby(lastVisualViewportRecord.data.width, initialVisualViewportDimension.width / finalScaleAmount)
        expectToBeNearby(lastVisualViewportRecord.data.height, initialVisualViewportDimension.height / finalScaleAmount)

        expect(lastVisualViewportRecord.data.offsetLeft).toBeGreaterThan(0)
        expect(lastVisualViewportRecord.data.offsetTop).toBeGreaterThan(0)
        expect(lastVisualViewportRecord.data.pageLeft).toBeGreaterThan(0)
        expect(lastVisualViewportRecord.data.pageTop).toBeGreaterThan(0)
      })
  })
})

function getLastSegment(events: EventRegistry) {
  return events.sessionReplay[events.sessionReplay.length - 1].segment.data
}

function initRumAndStartRecording(initConfiguration: RumInitConfiguration) {
  window.DD_RUM!.init(initConfiguration)
  window.DD_RUM!.startSessionReplayRecording()
}

const isGestureUnsupported = () => {
  const { capabilities } = browser
  return (
    capabilities.browserName === 'firefox' ||
    capabilities.browserName === 'Safari' ||
    capabilities.browserName === 'msedge' ||
    capabilities.platformName === 'windows' ||
    capabilities.platformName === 'linux'
  )
}

// Flakiness: Working with viewport sizes has variations per device of a few pixels
function expectToBeNearby(numA: number, numB: number) {
  const roundedA = Math.round(numA)
  const roundedB = Math.round(numB)
  const test = Math.abs(roundedA - roundedB) <= 5
  if (test) {
    expect(test).toBeTruthy()
  } else {
    // Prints a clear error message when different
    expect(roundedB).toBe(roundedA)
  }
}

async function pinchZoom(xChange: number) {
  // Cannot exceed the bounds of a device's screen, at start or end positions.
  // So pick a midpoint on small devices, roughly 180px.
  const xBase = 180
  const yBase = 180
  const xOffsetFingerTwo = 25
  // Scrolling too fast can show or hide the address bar on some device browsers.
  const moveDurationMs = 400
  const pauseDurationMs = 150
  const actions = [
    {
      type: 'pointer',
      id: 'finger1',
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: xBase, y: yBase },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: pauseDurationMs },
        { type: 'pointerMove', duration: moveDurationMs, origin: 'pointer', x: -xChange, y: 0 },
        { type: 'pointerUp', button: 0 },
      ],
    },
    {
      type: 'pointer',
      id: 'finger2',
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: xBase + xOffsetFingerTwo, y: yBase },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: pauseDurationMs },
        { type: 'pointerMove', duration: moveDurationMs, origin: 'pointer', x: +xChange, y: 0 },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ]
  await driver.performActions(actions)
}

async function performSignificantZoom() {
  const initialVisualViewport = await getVisualViewport()
  await pinchZoom(150)
  await pinchZoom(150)
  const nextVisualViewport = await getVisualViewport()
  // Test the test: ensure pinch zoom was applied
  expect(initialVisualViewport.scale < nextVisualViewport.scale).toBeTruthy()
}

async function pinchScrollVerticallyDown(yChange: number) {
  // Providing a negative offset value will scroll up.
  // NOTE: Some devices may invert scroll direction
  // Cannot exceed the bounds of a device's screen, at start or end positions.
  // So pick a midpoint on small devices, roughly 180px.
  const xBase = 180
  const yBase = 180
  // Scrolling too fast can show or hide the address bar on some device browsers.
  const moveDurationMs = 800
  const pauseDurationMs = 150

  const actions = [
    {
      type: 'pointer',
      id: 'finger1',
      parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: xBase, y: yBase },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: pauseDurationMs },
        { type: 'pointerMove', duration: moveDurationMs, origin: 'pointer', x: 0, y: -yChange },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ]
  await driver.performActions(actions)
}

async function buildScrollablePage() {
  await browserExecute(() => {
    document.documentElement.style.setProperty('width', '5000px')
    document.documentElement.style.setProperty('height', '5000px')
    document.documentElement.style.setProperty('margin', '0px')
    document.documentElement.style.setProperty('padding', '0px')
    document.body.style.setProperty('margin', '0px')
    document.body.style.setProperty('padding', '0px')
    document.body.style.setProperty('width', '5000px')
    document.body.style.setProperty('height', '5000px')
  })
}

interface VisualViewportData {
  scale: number
  width: number
  height: number
  offsetLeft: number
  offsetTop: number
  pageLeft: number
  pageTop: number
}

function getVisualViewport(): Promise<VisualViewportData> {
  return browserExecute(() => {
    const visual = window.visualViewport || {}
    return {
      scale: visual.scale,
      width: visual.width,
      height: visual.height,
      offsetLeft: visual.offsetLeft,
      offsetTop: visual.offsetTop,
      pageLeft: visual.pageLeft,
      pageTop: visual.pageTop,
    }
  }) as Promise<VisualViewportData>
}

function getWindowScroll() {
  return browserExecute(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  })) as Promise<{ scrollX: number; scrollY: number }>
}

function getScrollbarWidth(): Promise<number> {
  // https://stackoverflow.com/questions/13382516/getting-scroll-bar-width-using-javascript#answer-13382873
  return browserExecute(() => {
    // Creating invisible container
    const outer = document.createElement('div')
    outer.style.visibility = 'hidden'
    outer.style.overflow = 'scroll' // forcing scrollbar to appear
    ;(outer.style as any).msOverflowStyle = 'scrollbar' // needed for WinJS apps
    document.body.appendChild(outer)
    // Creating inner element and placing it in the container
    const inner = document.createElement('div')
    outer.appendChild(inner)
    // Calculating difference between container's full width and the child width
    const scrollbarWidth = outer.offsetWidth - inner.offsetWidth
    // Removing temporary elements from the DOM
    document.body.removeChild(outer)
    return scrollbarWidth
  }) as Promise<number>
}

// Mac OS X Chrome scrollbars are included here (~15px) which seems to be against spec
// Scrollbar edge-case handling not considered right now, further investigation needed
async function getScrollbarCorrection(): Promise<number> {
  let scrollbarWidth = 0
  if (browser.capabilities.browserName === 'chrome' && browser.capabilities.platformName === 'mac os x') {
    scrollbarWidth = await getScrollbarWidth()
  }
  return scrollbarWidth
}

async function getLastRecord<T>(events: EventRegistry, filterMethod: (segment: any) => T[]): Promise<T> {
  await flushEvents()
  const segment = getLastSegment(events)
  const foundRecords = filterMethod(segment)
  return foundRecords[foundRecords.length - 1]
}

function getWindowInnerDimensions() {
  return browserExecute(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  })) as Promise<{ innerWidth: number; innerHeight: number }>
}

async function resetLayoutScroll() {
  await browserExecute(() => {
    window.scrollTo(-500, -500)
  })
  const { scrollX: nextScrollX, scrollY: nextScrollY } = await getWindowScroll()
  // Ensure our methods are applied correctly
  expect(nextScrollX).toBe(0)
  expect(nextScrollY).toBe(0)
}

async function layoutScrollTo(scrollX: number, scrollY: number) {
  await browser.execute(
    (x, y) => {
      window.scrollTo(x, y)
    },
    scrollX,
    scrollY
  )
  const { scrollX: nextScrollX, scrollY: nextScrollY } = await getWindowScroll()
  // Ensure our methods are applied correctly
  expect(scrollX).toBe(nextScrollX)
  expect(scrollY).toBe(nextScrollY)
}
