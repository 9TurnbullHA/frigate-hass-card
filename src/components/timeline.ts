// TODO: Editor support for timeline (incl. in views).
// TODO: Make thumbnail controls optional (in all places that use thumbnails).
// TODO: Search for TODOs and logging statements.

import {
  CSSResultGroup,
  LitElement,
  TemplateResult,
  html,
  unsafeCSS,
  PropertyValues,
} from 'lit';
import { DataSet } from 'vis-data/esnext';
import {
  DataGroupCollectionType,
  Timeline,
  TimelineItem,
  TimelineOptions,
  TimelineOptionsCluster,
  TimelineWindow,
} from 'vis-timeline/esnext';
import { HomeAssistant } from 'custom-card-helpers';
import { classMap } from 'lit/directives/class-map.js';
import { customElement, property } from 'lit/decorators.js';
import { createRef, ref, Ref } from 'lit/directives/ref.js';
import { add, fromUnixTime, sub } from 'date-fns';
import { isEqual } from 'lodash-es';

import { BrowseMediaUtil } from '../browse-media-util';
import {
  CameraConfig,
  ExtendedHomeAssistant,
  FrigateBrowseMediaSource,
  MEDIA_CLASS_PLAYLIST,
  MEDIA_TYPE_PLAYLIST,
  TimelineConfig,
  FrigateEvent,
} from '../types';
import { View, ViewContext } from '../view';
import {
  dispatchErrorMessageEvent,
  dispatchFrigateCardEvent,
  getCameraTitle,
} from '../common.js';

import timelineCoreStyle from '../scss/timeline-core.scss';
import timelineStyle from '../scss/timeline.scss';

import './surround-thumbnails.js';

const TIMELINE_EVENT_MANAGER_MAX_AGE_SECONDS = 10;

interface FrigateCardGroupData {
  id: string;
  content: string;
}
interface FrigateCardTimelineItem extends TimelineItem {
  event: FrigateEvent;
  clip?: FrigateBrowseMediaSource;
  snapshot?: FrigateBrowseMediaSource;
}

interface TimelineViewContext extends ViewContext {
  window: TimelineWindow;
}

type TimelineMediaType = 'all' | 'clips' | 'snapshots';

/**
 * A manager to maintain/fetch timeline events.
 */
class TimelineEventManager {
  protected _dataset = new DataSet<FrigateCardTimelineItem>();

  // The earliest date managed.
  protected _dateStart?: Date;

  // The latest date managed.
  protected _dateEnd?: Date;

  // The last fetch date.
  protected _dateFetch?: Date;

  // The maximum allowable age of fetch data (will not fetch more frequently
  // than this).
  protected _maxAgeSeconds: number = TIMELINE_EVENT_MANAGER_MAX_AGE_SECONDS;

  protected _contentCallback?: (source: FrigateBrowseMediaSource) => string;
  protected _tooltipCallback?: (source: FrigateBrowseMediaSource) => string;

  constructor(params?: {
    contentCallback?: (source: FrigateBrowseMediaSource) => string;
    tooltipCallback?: (source: FrigateBrowseMediaSource) => string;
  }) {
    this._contentCallback = params?.contentCallback;
    this._tooltipCallback = params?.tooltipCallback;
  }

  /**
   * Retrieve the underlying dataset.
   */
  get dataset(): DataSet<FrigateCardTimelineItem> {
    return this._dataset;
  }

  /**
   * Determine if the dataset is empty.
   * @returns
   */
  public isEmpty(): boolean {
    return this._dataset.length === 0;
  }

  /**
   * Clear the dataset.
   */
  public clear(): void {
    this._dataset.clear();
  }

  /**
   * Add a FrigateBrowseMediaSource object to the managed timeline.
   * @param camera The id the camera this object is from.
   * @param target The FrigateBrowseMediaSource to add.
   */
  protected _addMediaSource(camera: string, target: FrigateBrowseMediaSource): void {
    const items: FrigateCardTimelineItem[] = [];
    target.children?.forEach((child) => {
      const event = child.frigate?.event;
      if (event && ['video', 'image'].includes(child.media_content_type)) {
        let item = this._dataset.get(event.id);
        if (!item) {
          item = {
            id: event.id,
            group: camera,
            content: this._contentCallback?.(child) ?? '',
            title: this._tooltipCallback?.(child) ?? '',
            start: event.start_time * 1000,
            event: event,
          };
        }
        if (event.end_time) {
          item['end'] = event.end_time * 1000;
          item['type'] = 'range';
        } else {
          item['type'] = 'point';
        }
        if (child.media_content_type === 'video') {
          item['clip'] = child;
        } else if (child.media_content_type === 'image') {
          item['snapshot'] = child;
        }
        items.push(item);
      }
    });
    this._dataset.update(items);
  }

  /**
   * Determine if the timeline has coverage for a given range of dates.
   * @param start The start of the date range.
   * @param end An optional end of the date range.
   * @returns
   */
  public hasCoverage(start: Date, end?: Date): boolean {
    const now = new Date().getTime();

    // Never fetched: no coverage.
    if (!this._dateFetch || !this._dateStart || !this._dateEnd) {
      return false;
    }

    // If the most recent fetch is older than maxAgeSeconds: no coverage.
    if (
      this._maxAgeSeconds &&
      now - this._dateFetch.getTime() > this._maxAgeSeconds * 1000
    ) {
      return false;
    }

    // If the most requested data is earlier than the earliest stored: no
    // coverage.
    if (start < this._dateStart) {
      return false;
    }

    // If there's no end time specified: there IS coverage.
    if (!end) {
      return true;
    }
    // If the requested end time is older than the oldest requested: there IS
    // coverage.
    if (end.getTime() < this._dateEnd.getTime()) {
      return true;
    }
    // If there's no maxAgeSeconds specified: no coverage.
    if (!this._maxAgeSeconds) {
      return false;
    }
    // If the requested end time is beyond `_maxAgeSeconds` of now: no coverage.
    if (now - end.getTime() > this._maxAgeSeconds * 1000) {
      return false;
    }

    // End time is within `_maxAgeSeconds` of the latest data: there IS
    // coverage.
    return end.getTime() - this._maxAgeSeconds * 1000 <= this._dateEnd.getTime();
  }

  /**
   * Fetch events if no coverage in given range.
   * @param element The element to send error events from.
   * @param hass The HomeAssistant object.
   * @param cameras The cameras map.
   * @param start Fetch events that start later than this date.
   * @param end Fetch events that start earlier than this date.
   * @returns `true` if events were fetched, `false` otherwise.
   */
  public async fetchEventsIfNecessary(
    element: HTMLElement,
    hass: HomeAssistant & ExtendedHomeAssistant,
    cameras: Map<string, CameraConfig>,
    media: TimelineMediaType,
    start: Date,
    end: Date,
  ): Promise<boolean> {
    if (this.hasCoverage(start, end)) {
      return false;
    }
    await this._fetchEvents(element, hass, cameras, media, start, end);
    return true;
  }

  /**
   * Fetch events for the timeline.
   * @param element The element to send error events from.
   * @param hass The HomeAssistant object.
   * @param cameras The cameras map.
   * @param start Fetch events that start later than this date.
   * @param end Fetch events that start earlier than this date.
   */
  protected async _fetchEvents(
    element: HTMLElement,
    hass: HomeAssistant & ExtendedHomeAssistant,
    cameras: Map<string, CameraConfig>,
    media: TimelineMediaType,
    start?: Date,
    end?: Date,
  ): Promise<void> {
    if (!this._dateStart || (start && start < this._dateStart)) {
      this._dateStart = start;
    }
    if (!this._dateEnd || (end && end > this._dateEnd)) {
      this._dateEnd = end;
    }
    if (!this._dateStart || !this._dateEnd) {
      return;
    }
    this._dateFetch = new Date();

    const fetchCameraEvents = async (
      camera: string,
      mediaType: 'clips' | 'snapshots',
    ): Promise<void> => {
      const cameraConfig = cameras.get(camera);
      if (!cameraConfig || !this._dateStart || !this._dateEnd) {
        return;
      }
      const browseMediaQueryParametersBase =
        BrowseMediaUtil.getBrowseMediaQueryParametersBase(cameraConfig);
      if (!browseMediaQueryParametersBase) {
        return;
      }
      try {
        this._addMediaSource(
          camera,
          await BrowseMediaUtil.browseMediaQuery(hass, {
            ...browseMediaQueryParametersBase,

            // Events are always fetched for the maximum extent of the managed
            // range. This is because events may change at any point in time
            // (e.g. a long-running event that ends).
            before: this._dateEnd.getTime() / 1000,
            after: this._dateStart.getTime() / 1000,
            unlimited: true,
            mediaType: mediaType,
          }),
        );
      } catch (e) {
        return dispatchErrorMessageEvent(element, (e as Error).message);
      }
    };

    const promises: Promise<void>[] = [];
    (media === 'all' ? ['clips', 'snapshots'] : [media]).forEach((mediaType) =>
      promises.push(
        ...Array.from(cameras.keys()).map((camera) =>
          fetchCameraEvents(camera, mediaType as 'clips' | 'snapshots'),
        ),
      ),
    );
    await Promise.all(promises);
  }
}

@customElement('frigate-card-timeline')
export class FrigateCardTimeline extends LitElement {
  @property({ attribute: false })
  protected hass?: HomeAssistant & ExtendedHomeAssistant;

  @property({ attribute: false })
  protected view?: Readonly<View>;

  @property({ attribute: false })
  protected cameras?: Map<string, CameraConfig>;

  @property({ attribute: false })
  protected timelineConfig?: TimelineConfig;

  /**
   * Master render method.
   * @returns A rendered template.
   */
  protected render(): TemplateResult | void {
    if (!this.timelineConfig) {
      return html``;
    }

    return html` <frigate-card-surround-thumbnails
      .hass=${this.hass}
      .view=${this.view}
      .config=${this.timelineConfig.controls.thumbnails}
    >
      <frigate-card-timeline-core
        .hass=${this.hass}
        .view=${this.view}
        .cameras=${this.cameras}
        .timelineConfig=${this.timelineConfig}
      >
      </frigate-card-timeline-core>
    </frigate-card-surround-thumbnails>`;
  }

  /**
   * Return compiled CSS styles.
   */
  static get styles(): CSSResultGroup {
    return unsafeCSS(timelineStyle);
  }
}

@customElement('frigate-card-timeline-core')
export class FrigateCardTimelineCore extends LitElement {
  @property({ attribute: false })
  protected hass?: HomeAssistant & ExtendedHomeAssistant;

  @property({ attribute: false })
  protected view?: Readonly<View>;

  @property({ attribute: false })
  protected cameras?: Map<string, CameraConfig>;

  @property({ attribute: false })
  protected timelineConfig?: TimelineConfig;

  protected _events = new TimelineEventManager({
    tooltipCallback: this._getTooltip.bind(this),
  });
  protected _refTimeline: Ref<HTMLElement> = createRef();
  protected _thumbnails?: FrigateBrowseMediaSource;
  protected _timeline?: Timeline;

  /**
   * Get a tooltip for a given timeline event.
   * @param source The FrigateBrowseMediaSource in question.
   * @returns The tooltip as a string to render.
   */
  protected _getTooltip(source: FrigateBrowseMediaSource): string {
    const thumbnailSizeAttr = this.timelineConfig
      ? `thumbnail_size="${this.timelineConfig.controls.thumbnails.size}"`
      : '';
    const eventAttr = source.frigate?.event
      ? `event='${JSON.stringify(source.frigate.event)}'`
      : '';

    // Cannot use Lit data-bindings as visjs requires a string for tooltips.
    // Note that changes to attributes here must be mirrored in the xss
    // whitelist in `_getOptions()` .
    return `
      <frigate-card-thumbnail
        details
        thumbnail="${source.thumbnail}"
        label="${source.title}"
        ${eventAttr}
        ${thumbnailSizeAttr}
      >
      </frigate-card-thumbnail>`;
  }

  /**
   * Master render method.
   * @returns A rendered template.
   */
  protected render(): TemplateResult | void {
    if (!this.hass || !this.view || !this.timelineConfig) {
      return;
    }

    const thumbnailsConfig = this.timelineConfig.controls.thumbnails;
    const timelineClasses = {
      timeline: true,
      'left-margin': thumbnailsConfig.mode === 'left',
      'right-margin': thumbnailsConfig.mode === 'right',
    };

    return html`<div
      class="${classMap(timelineClasses)}"
      ${ref(this._refTimeline)}
    ></div>`;
  }

  /**
   * Handle a range change in the timeline.
   * @param properties vis.js provided range information.
   */
  protected _timelineRangeHandler(properties: {
    start: Date;
    end: Date;
    byUser: boolean;
    event: Event;
  }): void {
    if (!properties.byUser) {
      return;
    }
    console.info(
      `Range changed: ${properties.start} -> ${properties.end} [${this._events.dataset.length}]`,
    );
    if (this.hass && this.cameras && this._timeline && this.timelineConfig) {
      this._events
        .fetchEventsIfNecessary(
          this,
          this.hass,
          this.cameras,
          this.timelineConfig.media,
          properties.start,
          properties.end,
        )
        .then((fetched: boolean) => {
          if (fetched) {
            this._generateThumbnails();
          }
        });

      // Update the view to ensure that future view changes do not cause a
      // scroll.
      this.view
        ?.evolve({
          context: {
            window: this._timeline.getWindow(),
          },
        })
        .dispatchChangeEvent(this);
    }
  }

  /**
   * Called when an object on the timeline is selected.
   * @param data The data about the selection.
   * @returns
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected _timelineSelectHandler(data: { items: string[]; event: Event }): void {
    if (!this._thumbnails || !this._thumbnails.children) {
      return;
    }

    const childIndex = data.items.length
      ? this._thumbnails.children.findIndex(
          (child) => child.frigate?.event.id === data.items[0],
        )
      : null;

    this.view
      ?.evolve({
        target: this._thumbnails,
        childIndex: childIndex,
      })
      .dispatchChangeEvent(this);

    if (childIndex !== null && childIndex >= 0) {
      dispatchFrigateCardEvent(this, 'thumbnails:open');
    } else {
      dispatchFrigateCardEvent(this, 'thumbnails:close');
    }
  }

  /**
   * Regenerate the thumbnails from the timeline events.
   * @returns
   */
  protected _generateThumbnails(): void {
    if (!this._timeline) {
      return;
    }

    const selected = this._timeline.getSelection();
    let childIndex = -1;
    const children: FrigateBrowseMediaSource[] = [];
    this._events.dataset.get({order: 'start'}).forEach((item) => {
      if (this.timelineConfig) {
        let added = false;
        if (
          item.clip &&
          ['all', 'clips'].includes(this.timelineConfig.media) &&
          BrowseMediaUtil.isTrueMedia(item.clip)
        ) {
          added = true;
          children.push(item.clip);
        } else if (
          item.snapshot &&
          ['all', 'snapshots'].includes(this.timelineConfig.media) &&
          BrowseMediaUtil.isTrueMedia(item.snapshot)
        ) {
          added = true;
          children.push(item.snapshot);
        }

        if (added && selected.includes(item.event.id)) {
          childIndex = children.length - 1;
        }
      }
    });
    if (!children.length) {
      return;
    }

    const target = {
      title: `Timeline events`,
      media_class: MEDIA_CLASS_PLAYLIST,
      media_content_type: MEDIA_TYPE_PLAYLIST,
      media_content_id: '',
      can_play: false,
      can_expand: true,
      children_media_class: MEDIA_CLASS_PLAYLIST,
      thumbnail: null,
      children: children,
    };

    if (!isEqual(target, this._thumbnails)) {
      this._thumbnails = target;

      // Update the thumbnail carousel with the regenerated thumbnails.
      this.view
        ?.evolve({
          target: this._thumbnails,
          childIndex: childIndex < 0 ? null : childIndex,
        })
        .dispatchChangeEvent(this);
    }
  }

  /**
   * Build the visjs dataset to render on the timeline.
   * @returns The dataset.
   */
  protected _getGroups(): DataGroupCollectionType {
    const groups: FrigateCardGroupData[] = [];
    this.cameras?.forEach((cameraConfig, camera) => {
      groups.push({
        id: camera,
        content: getCameraTitle(this.hass, cameraConfig),
      });
    });
    return new DataSet(groups);
  }

  /**
   * Given an event get an appropriate start/end time window around the event.
   * @param event The FrigateEvent to consider.
   * @returns A tuple of start/end date.
   */
  protected _getStartEndFromEvent(event: FrigateEvent): [Date, Date] {
    const one_hour = { hours: 1 };
    const start = sub(fromUnixTime(event.start_time), one_hour);
    let end: Date;

    if (event.end_time) {
      end = add(fromUnixTime(event.end_time), one_hour);
    } else {
      end = add(start, one_hour);
    }
    return [start, end];
  }

  /**
   * Get desired timeline start/end time.
   * @returns A tuple of start/end date.
   */
  protected _getStartEnd(): [Date, Date] {
    const event = this.view?.target?.frigate?.event;
    if (event) {
      return this._getStartEndFromEvent(event);
    }
    const one_hour = { hours: 1 };
    const end = new Date();
    const start = sub(end, one_hour);
    return [start, end];
  }

  /**
   * Determine if the timeline should use clustering.
   * @returns `true` if the timeline should cluster, `false` otherwise.
   */
  protected _isClustering(): boolean {
    return (
      !!this.timelineConfig?.clustering_threshold &&
      this.timelineConfig.clustering_threshold > 0
    );
  }

  /**
   * Handle timeline resize.
   */
  protected _getOptions(): TimelineOptions | void {
    if (!this.timelineConfig) {
      return;
    }

    const [start, end] = this._getStartEnd();

    // Configuration for the Timeline, see:
    // https://visjs.github.io/vis-timeline/docs/timeline/#Configuration_Options
    return {
      cluster: this._isClustering()
        ? {
            showStipes: true,
            // It would be better to automatically calculate `maxItems` from the
            // rendered height of the timeline (or group within the timeline) so
            // as to not waste vertical space (e.g. after the user changes to
            // fullscreen mode). Unfortunately this is not easy to do, as we
            // don't know the height of the timeline until after it renders --
            // and if we adjust `maxItems` then we can get into an infinite
            // resize loop. Adjusting the `maxItems` of a timeline, after it's
            // created, also does not appear to work as expected.
            maxItems: this.timelineConfig.clustering_threshold,

            clusterCriteria: (first: TimelineItem, second: TimelineItem): boolean => {
              // Never include the target media in a cluster, and never group
              // different object types together (e.g. person and car).
              return (
                !!first.id &&
                first.id !== this.view?.media?.frigate?.event?.id &&
                !!second.id &&
                second.id != this.view?.media?.frigate?.event?.id &&
                (<FrigateCardTimelineItem>first).event.label ===
                  (<FrigateCardTimelineItem>second).event.label
              );
            },
          }
        : (false as TimelineOptionsCluster),
      minHeight: '100%',
      maxHeight: '100%',
      zoomMax: 31 * 24 * 60 * 60 * 1000,
      zoomMin: 1 * 1000,
      selectable: true,
      start: start,
      end: end,
      groupHeightMode: 'fixed',
      tooltip: {
        followMouse: true,
        overflowMethod: 'cap',
      },
      xss: {
        disabled: false,
        filterOptions: {
          whiteList: {
            'frigate-card-thumbnail': [
              'details',
              'thumbnail',
              'label',
              'event',
              'thumbnail_size',
            ],
            div: ['title'],
            span: ['style'],
          },
        },
      },
    };
  }

  /**
   * Determine if the component should be updated.
   * @param _changedProps The changed properties.
   * @returns
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected shouldUpdate(_changedProps: PropertyValues): boolean {
    return !!this.hass && !!this.cameras && this.cameras.size > 0;
  }

  /**
   * Update the timeline from the view object.
   */
  protected async _updateTimelineFromView(): Promise<void> {
    if (
      !this.hass ||
      !this.cameras ||
      !this.view ||
      !this._timeline ||
      !this.timelineConfig
    ) {
      return;
    }

    const event = this.view?.media?.frigate?.event;
    const [windowStart, windowEnd] = event
      ? this._getStartEndFromEvent(event)
      : this._getStartEnd();

    if (
      await this._events.fetchEventsIfNecessary(
        this,
        this.hass,
        this.cameras,
        this.timelineConfig.media,
        windowStart,
        windowEnd,
      )
    ) {
      this._generateThumbnails();
    }

    this._timeline.setSelection(event ? [event.id] : [], {
      focus: false,
      animation: {
        animation: false,
        zoom: false,
      },
    });

    const context = this.view.context as TimelineViewContext | null;
    const timelineWindow = this._timeline.getWindow();

    if (context?.window) {
      console.info(
        `Setting window from context (${context.window.start} -> ${context.window.end}`,
      );
      if (!isEqual(context.window, timelineWindow)) {
        this._timeline.setWindow(context.window.start, context.window.end);
      }
    } else if (event) {
      const eventStart = new Date(event.start_time * 1000);
      const eventEnd = event.end_time ? new Date(event.end_time * 1000) : 0;

      if (
        eventStart < timelineWindow.start ||
        eventStart > timelineWindow.end ||
        (eventEnd && (eventEnd < timelineWindow.start || eventEnd > timelineWindow.end))
      ) {
        console.info(`Setting window from event ${windowStart} -> ${windowEnd}`);
        this._timeline.setWindow(windowStart, windowEnd);
      }

      if (this._isClustering()) {
        // Hack: Clustering may not update unless the dataset changes, artifically
        // update the dataset to ensure the newly selected item cannot be included
        // in a cluster.
        const item = this._events.dataset.get(event.id);
        if (item) {
          this._events.dataset.updateOnly(item);
        }
      }
    } else {
      console.info(`Setting window from live ${windowStart} -> ${windowEnd}`);
      this._timeline.setWindow(windowStart, windowEnd);
    }
  }

  /**
   * Called when the component is updated.
   * @param changedProperties The changed properties if any.
   */
  protected updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);

    if (changedProperties.has('cameras')) {
      this._events.clear();
      this._timeline?.destroy();
      this._timeline = undefined;
    }

    const options = this._getOptions();
    if (changedProperties.has('timelineConfig') && this._refTimeline.value && options) {
      if (this._timeline) {
        // TODO this._timeline.setOptions(options);
      } else {
        this._timeline = new Timeline(
          this._refTimeline.value,
          this._events.dataset,
          this._getGroups(),
          options,
        );
        this._timeline.on('select', this._timelineSelectHandler.bind(this));
        this._timeline.on('rangechanged', this._timelineRangeHandler.bind(this));
      }
    }

    if (changedProperties.has('view')) {
      this._updateTimelineFromView();
    }
  }

  /**
   * Return compiled CSS styles.
   */
  static get styles(): CSSResultGroup {
    return unsafeCSS(timelineCoreStyle);
  }
}
