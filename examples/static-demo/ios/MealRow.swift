import SwiftUI

struct MealList: View {
    let meals: [Meal]
    var body: some View {
        ScrollView {
            VStack {
                ForEach(meals) { meal in MealRow(meal: meal) }
            }
        }
    }
}

struct MealRow: View {
    let meal: Meal
    var body: some View {
        let formatter = DateFormatter()
        Text(formatter.string(from: meal.date))
    }
}
