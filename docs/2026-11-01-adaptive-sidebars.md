# Adaptive North Wildwood sidebars

Short laptop work areas could clip the left or right controls behind an internal scrollbar. The old layout bounded the sidebar containers without checking whether their contents actually fit. Display scaling, browser zoom, and the taller Modeled Floods controls exposed the problem.

The unified controller now measures both sidebars against the available space above the timeline. It preserves the original spacing when it fits, then reduces card spacing and reorganizes controls before introducing scrolling. In the tight desktop layout, layers use two columns, Export and Tour share a row, and the modeled-flood buttons become a native select with all 13 original scenarios. The select invokes the existing scenario buttons; flood calculations and data sources are unchanged.

The timestamp can move into the space between the sidebars to free vertical room. Resizing, font loading, changing modes, and content changes all trigger another fit calculation. Primary desktop text stays at least 12px and controls retain at least 24px targets; the app does not scale the entire interface with CSS zoom or transforms.

Windows at most 560 CSS pixels tall use the existing tabbed controls drawer. Narrow screens and touch laptops retain their existing drawer policy. The short, wide presentation includes a labeled Controls button, a collapsible Key, and readable timeline day labels. Drawer tabs retain 44px targets. If enlarged text still cannot fit, desktop sidebars restore full-width rows and scroll instead of retaining compressed columns. Legend labels and address controls wrap in that fallback. Expanded lists and unusually constrained content can still scroll inside the drawer or bounded sidebar.

## Validation

`tools/test_north_wildwood_adaptive_sidebar_fit.mjs` exercises the real app in Forecast, Past, and Modeled Floods modes. It checks full content visibility, pointer reachability, readable text, target sizes, and clearance between the sidebars, timestamp, title, navigation, and timeline. Desktop work areas range from 1512×945 to 1024×576, with separate 1.25 and 1.5 device-scale contexts. Short and wide windows, touch laptops, phones, and a 768×432 zoom-equivalent work area exercise the drawer. It also selects a different modeled scenario and advances the Flood Stages timeline to its end.

The regression runs with the existing Linux Chromium and WebKit checks and the Windows Chromium, Edge, and Firefox matrix. Browser viewport tests model logical screen space and scaling; they do not substitute for checking every physical device or native Safari installation. Visual screenshots supplement the geometry assertions.

Build parity retains every prior fixture and mutation case. The new adaptive-sidebar fixture reverses only this change before applying the earlier parity checks; generated files and cache keys remain checked against their actual bytes.
