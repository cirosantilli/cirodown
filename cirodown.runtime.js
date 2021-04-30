// https://cirosantilli.com/cirodown#insane-link-parsing-rules

function cirodown_runtime(toplevel) {
  if (toplevel === undefined) {
    toplevel = document;
  }

  // ToC interaction.
  const CLOSE_CLASS = 'close';
  const TOC_CONTAINER_CLASS = 'toc-container';
  const toc_arrows = toplevel.querySelectorAll(`.${TOC_CONTAINER_CLASS} div.arrow`);
  for(const toc_arrow of toc_arrows) {
    toc_arrow.addEventListener('click', () => {
      // https://cirosantilli.com/cirodown#table-of-contents-javascript-open-close-interaction
      const parent_li = toc_arrow.parentElement.parentElement;
      let all_children_closed = true;
      let all_children_open = true;
      let was_open;
      if (parent_li.classList.contains(CLOSE_CLASS)) {
        was_open = false;
        // Open self.
        parent_li.classList.toggle(CLOSE_CLASS);
      } else {
        was_open = true;
        // Check if all children are closed.
        for (const toc_arrow_child of parent_li.childNodes) {
          if (toc_arrow_child.tagName === 'UL') {
            for (const toc_arrow_child_2 of toc_arrow_child.childNodes) {
              if (toc_arrow_child_2.tagName === 'LI') {
                if (toc_arrow_child_2.classList.contains(CLOSE_CLASS)) {
                  all_children_open = false;
                } else if (toc_arrow_child_2.classList.contains('has-child')) {
                  all_children_closed = false;
                }
              }
            }
          }
        }
      }
      // Open or close all children.
      if (!was_open) {
        parent_li.classList.remove(CLOSE_CLASS);
      } else {
        if (all_children_closed && !parent_li.classList.contains('toplevel')) {
          parent_li.classList.add(CLOSE_CLASS);
        }
        for (const toc_arrow_child of parent_li.childNodes) {
          if (toc_arrow_child.tagName === 'UL') {
            for (const toc_arrow_child_2 of toc_arrow_child.childNodes) {
              if (toc_arrow_child_2.tagName === 'LI') {
                if (all_children_closed) {
                  toc_arrow_child_2.classList.remove(CLOSE_CLASS);
                } else {
                  toc_arrow_child_2.classList.add(CLOSE_CLASS);
                }
              }
            }
          }
        }
      }
    });
  }

  // Open ToC when jumping to it from header.
  const h_to_tocs = toplevel.getElementsByClassName('cirodown-h-to-toc');
  for (const h_to_toc of h_to_tocs) {
    h_to_toc.addEventListener('click', () => {
      let cur_elem = toplevel.getElementById(h_to_toc.getAttribute('href').slice(1)).parentElement;
      while (!cur_elem.classList.contains(TOC_CONTAINER_CLASS)) {
        cur_elem.classList.remove(CLOSE_CLASS);
        cur_elem = cur_elem.parentElement;
      }
    });
  }

  // Video click to play.
  // https://github.com/cirosantilli/cirodown/issues/122
  const videos = toplevel.getElementsByTagName('video');
  for(const video of videos) {
    const parentNode = video.parentNode;
    let first = true;
    video.addEventListener('click', () => {
      if (first) {
        video.play();
      }
      first = false;
    });
  }

  // tablesort
  const tables = toplevel.getElementsByTagName('table');
  for(const table of tables) {
    new Tablesort(table);
  }

  const cirodown_canvas_demo_elems = toplevel.getElementsByClassName('cirodown-js-canvas-demo');
  const cirodown_canvas_demo_weakmap = new WeakMap();
  for (const cirodown_canvas_demo_elem of cirodown_canvas_demo_elems) {
    cirodown_canvas_demo_weakmap.set(cirodown_canvas_demo_elem, false);
    const observer = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach(entry => {
          if (entry.intersectionRatio > 0.0) {
            if (!cirodown_canvas_demo_weakmap.get(cirodown_canvas_demo_elem)) {
              cirodown_canvas_demo_weakmap.set(cirodown_canvas_demo_elem, true);
              eval(cirodown_canvas_demo_elem.childNodes[0].textContent).do_init(cirodown_canvas_demo_elem);
            }
          }
        });
      },
      {}
    )
    observer.observe(cirodown_canvas_demo_elem);
  }
}

// Load required scripts dynamically:
//
// * https://stackoverflow.com/questions/7308908/waiting-for-dynamically-loaded-script/57267538#57267538
// * https://stackoverflow.com/questions/14521108/dynamically-load-js-inside-js/14521482#14521482
// * https://stackoverflow.com/questions/10004112/how-can-i-wait-for-set-of-asynchronous-callback-functions
//
// We use to reduce the initial load time.
//
// Each script is loaded only once after it has finished loading for the first time,
// even if this function is called multiple times.
async function cirodown_load_scripts(script_urls) {
  function load(script_url) {
    return new Promise(function(resolve, reject) {
      if (cirodown_load_scripts.loaded.has(script_url)) {
        resolve();
      } else {
        var script = toplevel.createElement('script');
        script.onload = resolve;
        script.src = script_url
        toplevel.head.appendChild(script);
      }
    });
  }
  var promises = [];
  for (const script_url of script_urls) {
    promises.push(load(script_url));
  }
  await Promise.all(promises);
  for (const script_url of script_urls) {
    cirodown_load_scripts.loaded.add(script_url);
  }
}
cirodown_load_scripts.loaded = new Set();

// Create some nice controls for a canvas demo!
// TODO currently disabled on HTML because it would cause reflows on lower IDs.
// What we should do instead, is to only add the new elements on hover, this
// keeps thing simple, but still works.
class CirodownCanvasDemo {
  addInputAfterEnable(label, attributes) {
    var input = document.createElement('input');
    for (var key in attributes) {
      input.setAttribute(key, attributes[key]);
    }
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(label + ': '));
    div.appendChild(input);
    this.enable_div.parentNode.insertBefore(div, this.enable_div.nextSibling);
    return input;
  }

  addInfoSpanAfterEnable(label) {
    var span = document.createElement('span');
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(label + ': '));
    div.appendChild(span);
    this.enable_div.parentNode.insertBefore(div, this.enable_div.nextSibling);
    return span;

  }

  animate() {
    var fps_limit = parseFloat(this.fps_limit_input.value);
    if (!isNaN(fps_limit)) {
      var fps_limit_time_millis = 1000.0 / fps_limit;
      var now = Date.now();
      var fps_limit_elapsed = now - this.fps_limit_then;
    }
    if (isNaN(fps_limit) || (fps_limit_elapsed > fps_limit_time_millis)) {
      if (!isNaN(fps_limit)) {
        this.fps_limit_then = now - (fps_limit_elapsed % fps_limit_time_millis);
      }
      this.resizeCanvas();
      this.draw();

      // Save the images to files.
      // https://stackoverflow.com/questions/19235286/convert-html5-canvas-sequence-to-a-video-file/57153718#57153718
      if (this.save_images_input.checked) {
        this.canvas.toBlob(this.constructor.createBlobFunc(this.demo_id, this.time));
      }
      this.time++;
      this.total_frames_span.innerHTML = this.time.toString();

      /* FPS calculation. */
      var fps_granule = parseInt(this.fps_granule_input.value);
      if (this.time % fps_granule == 0) {
        var fps_date = Date.now();
        this.fps_span.innerHTML = (1000.0 * fps_granule / (fps_date - this.fps_last_date)).toFixed(2);
        this.fps_last_date = fps_date;
      }
    }
    if (this.enable_input.checked) {
      window.requestAnimationFrame(this.animate.bind(this));
    }
  }

  // We need this to fix time because toBlob calls are asynchronous.
  static createBlobFunc(demo_id, time) {
    return (blob) => {
      // From FileSaver.js.
      saveAs(blob, `canvas-${demo_id}-${time}.png`);
    };
  }

  // Do the actual drawing.
  draw() {
    throw new Error('unimplemented');
  }

  // Change the state from the old to the new.
  //
  // If it was disabled and now became enabled, start the animation.
  //
  // async because it may do long async steps like loading external libraries
  // on the first enable.
  async enableStateChange(new_state, old_state) {
    if (new_state) {
      if (!old_state) {
        this.enable_input.checked = true;
        if (!this.init_done) {
          await cirodown_load_scripts(['https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/1.3.8/FileSaver.min.js']);
          this.init_done = true;
        }
        console.log(`${this.myclass} starting: ${this.demo_id}`);
        window.requestAnimationFrame(this.animate.bind(this));
      }
    } else {
      if (old_state) {
        console.log(`${this.myclass} stopping: ${this.demo_id}`);
        this.enable_input.checked = false;
      }
    }
  }

  do_init(demo_element) {
    this.demo_element = demo_element;
    this.init();
  }

  init(demo_id, options) {
    this.demo_id = demo_id;
    this.options = Object.assign({}, options);
    if (!('enabled' in this.options)) {
      this.options.enabled = false;
    }
    if (!('context_type' in this.options)) {
      this.options.context_type = '2d';
    }

    // Members.
    this.time = 0;

    // Random variables.
    // https://stackoverflow.com/questions/19764018/controlling-fps-with-requestanimationframe
    this.fps_limit_then = Date.now();
    this.fps_last_date = new Date();

    // HTML.
    const canvas_wrapper = document.createElement('div');
    this.myclass = 'canvas-demo'
    canvas_wrapper.setAttribute('class', this.myclass);

    // Enable disable.
    this.enable_input = document.createElement('input');
    this.enable_input.setAttribute('type', 'checkbox');
    this.enable_input.setAttribute('value', '5');
    this.enable_input.setAttribute('min', '1');
    this.enable_input.addEventListener('change', async () => {
      this.enableStateChange(this.enable_input.checked, !this.enable_input.checked);
    });
    const enable_label = document.createElement('label');
    enable_label.appendChild(document.createTextNode('Enable: '));
    enable_label.appendChild(this.enable_input);
    enable_label.appendChild(document.createTextNode('<-- (click this to run!!!)'));
    this.enable_div = document.createElement('div');
    this.enable_div.appendChild(enable_label);
    canvas_wrapper.appendChild(this.enable_div);

    // All inputs and info entries.
    this.fps_span = this.addInfoSpanAfterEnable('FPS');
    this.total_frames_span = this.addInfoSpanAfterEnable('Total frames');
    this.fps_granule_input = this.addInputAfterEnable(
      'FPS granule',
      {
        'min': '1',
        'type': 'number',
        'value': '5'
      }
    );
    this.fps_limit_input = this.addInputAfterEnable(
      'FPS limit',
      {
        'min': '1',
        'type': 'number'
      }
    );
    this.save_images_input = this.addInputAfterEnable(
      'Save images',
      {
        'type': 'checkbox',
      }
    );
    this.canvas_width_input = this.addInputAfterEnable(
      'canvas width',
      {
        'min': '1',
        'type': 'number',
        'value': '128'
      }
    );

    // Canvas.
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('style', 'border:1px solid black;');
    canvas_wrapper.appendChild(this.canvas);
    this.ctx = this.canvas.getContext(this.options.context_type);
    this.resizeCanvas();

    // Add the canvas_wrapper.
    this.demo_element.parentNode.insertBefore(
      canvas_wrapper, this.demo_element
    );

    // Auto enable animations when they come into the viewport,
    // and disable them when they leave the viewport!!!
    //
    // This is done to prevent JavaScript animations from slowing the page down too much,
    // while still not requiring the user to click to enable all of them all the time.
    //
    // If the user explicitly disables then once, they are not automatically enabled anymore.
    //
    // https://stackoverflow.com/questions/123999/how-to-tell-if-a-dom-element-is-visible-in-the-current-viewport/15203639#15203639
    this.first_observer_init = true;
    const observer = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach(entry => {
          if (entry.intersectionRatio > 0.0) {
            // Just entered the viewport.
            if (this.first_observer_init) {
              this.first_observer_init = false;
              this.enableStateChange(true, this.enable_input.checked);
            }
          } else {
            // Just left the viewport.
            this.enableStateChange(false, this.enable_input.checked);
          }
        });
      },
      {}
    )
    observer.observe(canvas_wrapper);

    // Finish initialization.
    this.init_done = false;
    this.enableStateChange(this.options.enabled, this.enable_input.checked);
  }

  resizeCanvas() {
    const canvas_width = parseInt(this.canvas_width_input.value);
    if (isNaN(canvas_width)) {
      canvas_width = parseInt(this.canvas_width_input.getAttribute('value'));
    }
    this.canvas.width = canvas_width;
    this.canvas.height = canvas_width;
    this.width = canvas_width
    this.height = canvas_width
  }
}

// We want to do two things:
// - allow it being ran locally without a server. Modules don't work:
//   https://stackoverflow.com/questions/46992463/es6-module-support-in-chrome-62-chrome-canary-64-does-not-work-locally-cors-er
// - let webpack pick it up. Globals are not picked up by default.
//   https://stackoverflow.com/questions/37656592/define-global-variable-with-webpack
window.cirodown_runtime = cirodown_runtime;
//export { cirodown_runtime }
