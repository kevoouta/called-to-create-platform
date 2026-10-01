/**
 * CALLED TO CREATE - Master Catalog Data
 * Structure for BunnyStream URLs:
 * https://iframe.mediadelivery.net/embed/{LIBRARY_ID}/{VIDEO_ID}?autoplay=false&loop=false&muted=false&preload=true
 */

const CATALOG = [
  {
    id: "davinci-resolve-dark-moody",
    title: "Mastering DaVinci Resolve: Dark & Moody Visuals",
    category: "Color Grading",
    instructor: "Kevin Odongo",
    duration: "2h 45m",
    priceKES: 4500,
    priceUSD: 35,
    // Replace YOUR_LIBRARY_ID and YOUR_VIDEO_ID with your BunnyStream credentials when ready
    previewVideoUrl: "https://iframe.mediadelivery.net/embed/YOUR_LIBRARY_ID/YOUR_VIDEO_ID?autoplay=false&loop=false&muted=false&preload=true",
    description: "Learn color grading techniques to craft high-contrast, moody aesthetic looks in DaVinci Resolve. Focus on shadow management, keyer skin tones, and soft highlight roll-offs.",
    curriculum: [
      { 
        id: 1, 
        title: "01. Project Setup & Color Space Management", 
        duration: "12:15",
        videoUrl: "https://iframe.mediadelivery.net/embed/YOUR_LIBRARY_ID/LESSON_1_VIDEO_ID?autoplay=true&muted=false"
      },
      { 
        id: 2, 
        title: "02. Exposure & Contrast Control", 
        duration: "18:40",
        videoUrl: "https://iframe.mediadelivery.net/embed/YOUR_LIBRARY_ID/LESSON_2_VIDEO_ID?autoplay=true&muted=false"
      },
      { 
        id: 3, 
        title: "03. Delta Keyer & Power Windows", 
        duration: "24:10",
        videoUrl: "https://iframe.mediadelivery.net/embed/YOUR_LIBRARY_ID/LESSON_3_VIDEO_ID?autoplay=true&muted=false"
      },
      { 
        id: 4, 
        title: "04. Preserving Skin Tones in Shadow", 
        duration: "15:30",
        videoUrl: "https://iframe.mediadelivery.net/embed/YOUR_LIBRARY_ID/LESSON_4_VIDEO_ID?autoplay=true&muted=false"
      }
    ],
    assets: [
      { name: "Sample RAW Clips.zip", size: "1.2 GB", link: "#" },
      { name: "C2C Moody PowerGrade.drx", size: "45 KB", link: "#" }
    ]
  },
  {
    id: "cinematic-storytelling",
    title: "Cinematic Documentary Storytelling",
    category: "Filmmaking",
    instructor: "Kevin Odongo",
    duration: "3h 10m",
    priceKES: 6000,
    priceUSD: 45,
    previewVideoUrl: "https://iframe.mediadelivery.net/embed/YOUR_LIBRARY_ID/YOUR_VIDEO_ID_2?autoplay=false&loop=false&muted=false&preload=true",
    description: "A deep dive into visual framing, documentary interview setups, audio capturing, and crafting compelling narratives out of unscripted real-life footage.",
    curriculum: [
      { 
        id: 1, 
        title: "01. The Art of Unscripted Storytelling", 
        duration: "14:20",
        videoUrl: "https://iframe.mediadelivery.net/embed/YOUR_LIBRARY_ID/DOC_LESSON_1_ID?autoplay=true&muted=false"
      },
      { 
        id: 2, 
        title: "02. Lighting Natural Spaces & Characters", 
        duration: "22:05",
        videoUrl: "https://iframe.mediadelivery.net/embed/YOUR_LIBRARY_ID/DOC_LESSON_2_ID?autoplay=true&muted=false"
      },
      { 
        id: 3, 
        title: "03. Interview Audio & Ambient Sound", 
        duration: "19:45",
        videoUrl: "https://iframe.mediadelivery.net/embed/YOUR_LIBRARY_ID/DOC_LESSON_3_ID?autoplay=true&muted=false"
      }
    ],
    assets: [
      { name: "Documentary Pitch Deck Template.pdf", size: "8.4 MB", link: "#" },
      { name: "Interview Audio Presets.zip", size: "12 MB", link: "#" }
    ]
  }
];