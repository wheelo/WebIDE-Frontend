/* @flow weak */
import _ from 'lodash'
import React from 'react'
import {
  PANE_INITIALIZE,
  PANE_UNSET_COVER,
  PANE_RESIZE,
  PANE_CONFIRM_RESIZE,
  PANE_SPLIT
} from './actions'

// removeSingleChildedInternalNode 是为了避免无限级嵌套的 views.length === 1 出现
// i.e. {views: [{ views: [ {views: [ content ]} ]}]}
// 以上实际只需要 {views: [ content ]} 即可表达，中间的 wrapper 无用。
//
// 这个 func 做的就是干掉中间无用的 wrapper
// 使得 outermostWrapper.views = innerMostWrapper.views && return outermostWrapper;
const removeSingleChildedInternalNode = (view, originalWrapper) => {
  if (view.views && view.views.length === 1) {
    let lonelyItem = view.views[0]
    if (typeof lonelyItem === 'string') { // then spawn tab group
      if (originalWrapper) {
        let _view = view
        view = originalWrapper
        view.views = _view.views
      }
      return view
    }
    return removeSingleChildedInternalNode(lonelyItem, view)
  } else {
    if (originalWrapper) {
      let _view = view
      view = originalWrapper
      view.views = _view.views
    }
    return view
  }
}


class Pane {
  constructor (viewConfig, parent) {
    viewConfig = removeSingleChildedInternalNode(viewConfig)
    const { id, flexDirection, size } = viewConfig
    this.id = id || _.uniqueId('pane_view_')
    this.flexDirection = flexDirection || 'row'
    this.size = size || 100

    if (parent) {
      this.parentId = parent.id
    } else {
      this.isRoot = true
      Pane.root = this
    }

    if (Array.isArray(viewConfig.views)) {
      this.views = viewConfig.views.map(_viewConfig => {
        if (typeof _viewConfig === 'string') {
          if (!_viewConfig.startsWith('tab_group_')) {
            _viewConfig = _.uniqueId('tab_group_')
          }
          return _viewConfig
        } else {
          return new Pane(_viewConfig, this)
        }
      })
    } else {
      this.views = []
    }

    Pane.indexes[this.id] = this
  }

  splitPane (splitCount=this.views.length+1, flexDirection=this.flexDirection) {
    this.flexDirection = flexDirection
    if (splitCount <= 0) splitCount = 1
    if (splitCount === this.views.length) return []

    let tabGroupIdsToBeMerged = []
    if (splitCount > this.views.length) {
      // add pane split
      if (this.views.length === 1) {
        let currentTabGroupId = this.views.pop()
        this.views.push(new Pane({views:[currentTabGroupId]}))
        while (--splitCount) this.views.push(new Pane({views:['']}))
      } else {
        while (splitCount > this.views.length) {
          this.views.push(new Pane({views:['']}))
        }
      }
    } else {
      // merge pane split
      while (splitCount < this.views.length) {
        let viewToBeMerged = this.views.pop()
        tabGroupIdsToBeMerged = tabGroupIdsToBeMerged.concat(viewToBeMerged.getTabGroupIds())
      }
    }

    // removeSingleChildedInternalNode, and even the size
    if (this.views.length === 1) {
      let lonelyItem = this.views[0]
      if (lonelyItem.views && typeof lonelyItem.views[0] === 'string') {
        this.views = lonelyItem.views
      }
    } else {
      let baseSize = this.views[0]['size']
      this.views.forEach( view => view.size = baseSize )
    }

    // handle tab groups merging
    let tabGroupIdToMergeInto = this.views[this.views.length - 1]
    if (typeof tabGroupIdToMergeInto !== 'string') {
      tabGroupIdToMergeInto = tabGroupIdToMergeInto.getTabGroupIds()[0]
    }

    // then we're going to merge tab group from right to left
    return [tabGroupIdToMergeInto].concat(tabGroupIdsToBeMerged)
  }

  getTabGroupIds () {
    return this.views.reduceRight((acc, view) => {
      if (typeof view === 'string') {
        return acc.concat(view)
      } else {
        return acc.concat(view.getTabGroupIds())
      }
    }, [])
  }
}


Pane.indexes = {}
const getViewById = (id) => Pane.indexes[id]
const debounced = _.debounce(function (func) { func() }, 50)

const _state = {
  root: new Pane({
    id: 'pane_view_1',
    flexDirection: 'row',
    size: 100,
    views: ['']
  })
}
export default function PaneReducer (state = _state, action) {
  switch (action.type) {
    case PANE_RESIZE:
      let section_A = getViewById(action.sectionId)
      let parent = getViewById(section_A.parentId)
      let section_B = parent.views[parent.views.indexOf(section_A) + 1]
      let section_A_Dom = document.getElementById(section_A.id)
      let section_B_Dom = document.getElementById(section_B.id)
      var r, rA, rB
      if (parent.flexDirection === 'column') {
        r = action.dY
        rA = section_A_Dom.offsetHeight
        rB = section_B_Dom.offsetHeight
      } else {
        r = action.dX
        rA = section_A_Dom.offsetWidth
        rB = section_B_Dom.offsetWidth
      }
      section_A.size = section_A.size * (rA - r) / rA
      section_B.size = section_B.size * (rB + r) / rB

      section_A_Dom.style.flexGrow = section_A.size
      section_B_Dom.style.flexGrow = section_B.size

      // @coupled: trigger resize of children ace editor
      debounced(function () {
        section_A_Dom.querySelectorAll('[data-ace-resize]').forEach(
          editorDOM => editorDOM.$ace_editor.resize()
        )
        section_B_Dom.querySelectorAll('[data-ace-resize]').forEach(
          editorDOM => editorDOM.$ace_editor.resize()
        )
      })

      return state

    case PANE_CONFIRM_RESIZE:
      return state



    default:
      return state
  }
}

export function PaneCrossReducer (allStates, action) {
  switch (action.type) {
    case PANE_SPLIT:
      const {Panes, TabState} = allStates
      var pane = Panes.root
      if (action.splitCount === pane.views.length &&
        action.flexDirection === pane.flexDirection) {
        return allStates
      }

      pane = new Pane(pane)
      var tabGroupIds = pane.splitPane(action.splitCount, action.flexDirection)
      if (tabGroupIds.length > 1) {
        const tabGroupIdToMergeInto = tabGroupIds[0]
        const tabGroupIdsToBeMerged = tabGroupIds.slice(1)
        var mergedTabs = tabGroupIdsToBeMerged.reduceRight((acc, tabGroupId) => {
          var tabGroup = TabState.getGroupById(tabGroupId)
          tabGroup.deactivateAllTabsInGroup()
          return [...tabGroup.tabs, ...acc]
        }, [])
        var mergerTabGroup = TabState.getGroupById(tabGroupIdToMergeInto)
        mergerTabGroup.mergeTabs(mergedTabs)
      }
      return { ...allStates,
        Panes: {root: new Pane(pane)},
        TabState: TabState.normalizeState(TabState) }

    default:
      return allStates
  }
}
